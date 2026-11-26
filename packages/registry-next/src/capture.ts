// What GitHub Actions deletes: each build job's log (~90 days) and its check artifact (the
// record's _expires, ~100 days), copied into BUCKET from capture_queue before they go, with the
// build environment read out of the log. A missed one is unrecoverable, so a failure stops the
// drain and the row waits, backing off, rather than being passed.
import type { Sql } from "postgres";
import type { Env } from "./db.ts";
import { fixedLength } from "./ingest.ts";

// GitHub allows 5,000 requests an hour per token, and the current registry spends ~2,400 of
// them on the same token until it is turned off. A log costs one api.github.com call and a check
// one (its ranges go to the blob host the API redirects to), so at four ticks an hour these
// defaults spend at most 400 more.
export const LOGS_PER_TICK = 50;
export const CHECKS_PER_TICK = 50;
// Job logs above this are streamed to R2 instead of read as text (captureLog).
const LOG_TEXT_MAX = 16_000_000;
const MANIFEST_SCAN = 8_000_000;

const ghHeaders = (token: string) => ({ "user-agent": "bioc-registry-next", authorization: `Bearer ${token}` });

// True when saved, false when the job is gone upstream. Throws when the walk should
// stop and retry later.
export async function captureLog(
  bucket: R2Bucket, universe: string, job: string, token: string, f: typeof fetch,
): Promise<boolean> {
  const gh = await f(
    `https://api.github.com/repos/r-universe/${universe}/actions/jobs/${job}/logs`,
    { headers: ghHeaders(token) }
  );
  // Only 404/410 (already expired upstream) is terminal; callers move past those
  // rather than wedging on a dead job. Anything else must stop the walk. Treating it
  // as terminal is how an expired token (401 on every job) walked the mark through
  // two months of logs, saving none (#69).
  if (gh.status === 404 || gh.status === 410) return false;
  if (!gh.ok) throw new Error(`HTTP ${gh.status}`);
  const key = `logs/${universe}/${job}.txt`;
  // A missing length is a retry, not "small": read as text, a lengthless 226MB log would take the
  // isolate down exactly as the streaming below exists to prevent (as openArtifact does).
  const raw = gh.headers.get("content-length");
  const len = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(len)) {
    await gh.body?.cancel().catch(() => {});
    throw new Error(`job ${job} log: no content-length`);
  }
  let log: string;
  if (gh.body && len > LOG_TEXT_MAX) {
    // Streamed, so the log is kept whole without being held in memory. A flood of
    // compiler warnings reaches 226MB (bioc job 121603050065, RcppEigen templates),
    // and reading that as text exceeded the isolate's 128MB on every run, wedging
    // the bioc cursor from 2026-10-26 to 2026-11-12. The manifest is read from the
    // head, which is where the dependency installs are.
    await bucket.put(key, fixedLength(gh.body, len), { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    log = (await (await bucket.get(key, { range: { offset: 0, length: MANIFEST_SCAN } }))?.text()) ?? "";
  } else {
    log = await gh.text();
    await bucket.put(key, log, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  }
  const manifest = buildManifest(log);
  // Skipped when it found nothing: a log with no install section says nothing
  // about the build, and an empty manifest would read as "no dependencies"
  // rather than "not recorded".
  if (manifest.image || Object.keys(manifest.deps).length)
    await bucket.put(`builds/${universe}/${job}.json`, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
  return true;
}

// ---------- check-log capture ----------
// captureLog stores the GHA *job* log: the runner's own output — docker pulls,
// dependency installs, compiler noise. A 9.1MB one measured here holds six
// "* checking" lines and no check verdict at all. What a maintainer actually reads
// is in the job's uploaded artifact:
//
//   00check.log      R CMD check's verdict and every failing section
//   00install.out    the build log for that platform
//   *-Ex.Rout        the example transcript (.fail when examples errored)
//   tests/*.Rout     the test transcript (.Rout.fail when tests errored)
//   00BiocCheck.log  BiocCheck's report, on the bioc-checks config
//   build.log        wasm builds
//
// These expire with the artifact — the observation's _expires is the deadline,
// ~100 days out — so a missed one is unrecoverable, exactly like a job log.
//
// The artifact is a zip holding up to 7.6MB of built package around ~65KB of that
// text (measured across 24 jobs: mean 65KB, max 356KB). Fetching them whole would
// be ~11GB/day, so only the text entries are pulled: HEAD for the length, one
// range for the central directory at the end, one per wanted entry. The blob host
// the API redirects to honours ranges but NOT the suffix form — `bytes=-65536`
// comes back 200 with the entire file — which is why the length is looked up
// rather than assumed.
const ZIP_TAIL = 64 * 1024;
// A local file header repeats the name and carries its own extra field, so the
// data does not begin where the central directory alone can say. Over-fetching by
// this much and reading the real lengths costs ~1KB an entry against a second
// round trip for every one of them.
const ZIP_HEADER_SLACK = 1024;
// Upstream text, so it needs a ceiling: one pathological transcript must not take
// down the isolate that is also running poll and observe.
const MAX_LOG_BYTES = 4_000_000;

// Null for anything terminal: the API's 404/410 (expired, or never existed), an artifact with no
// length, a zip whose directory does not parse. Every other failure, at any hop, throws so the
// row is retried: a null there marks the job gone, and a skipped entry saves it partial, done.
export async function fetchCheckLogs(
  universe: string, artifact: string, token: string, f: typeof fetch,
): Promise<Record<string, string> | null> {
  // The API answers 302 to a signed blob URL, and that URL — not the API — is
  // what serves ranges, so the hop is taken by hand instead of followed.
  const res = await f(
    `https://api.github.com/repos/r-universe/${universe}/actions/artifacts/${artifact}/zip`,
    { headers: ghHeaders(token), redirect: "manual" }
  );
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
    throw new Error("rate limited");
  // 404/410 is terminal — the artifact expired or never existed — and the cursor
  // should move past it. Anything else without a redirect is NOT terminal, and
  // must throw: a silent null there would march the cursor through the whole
  // backlog marking every job unavailable, burning the one chance to capture it.
  if (res.status === 404 || res.status === 410) return null;
  const url = res.headers.get("location");
  if (!url) throw new Error(`artifact ${artifact}: no redirect (HTTP ${res.status})`);

  const head = await f(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`artifact ${artifact}: HEAD HTTP ${head.status}`);
  const total = Number(head.headers.get("content-length") ?? 0);
  if (!total) return null;

  const from = Math.max(0, total - ZIP_TAIL);
  const tail = await f(url, { headers: { range: `bytes=${from}-${total - 1}` } });
  if (!tail.ok) throw new Error(`artifact ${artifact}: directory HTTP ${tail.status}`);
  const entries = parseZipCentral(new Uint8Array(await tail.arrayBuffer()), from);
  if (!entries) return null;

  const logs: Record<string, string> = {};
  for (const e of entries) {
    if (!isLogEntry(e.name) || e.size > MAX_LOG_BYTES) continue;
    const end = Math.min(total - 1, e.offset + 30 + ZIP_HEADER_SLACK + e.compressed);
    const part = await f(url, { headers: { range: `bytes=${e.offset}-${end}` } });
    if (!part.ok) throw new Error(`artifact ${artifact}: ${e.name} HTTP ${part.status}`);
    const buf = new Uint8Array(await part.arrayBuffer());
    const start = 30 + (buf[26] | (buf[27] << 8)) + (buf[28] | (buf[29] << 8));
    if (start + e.compressed > buf.length) continue; // slack was not enough
    const data = buf.subarray(start, start + e.compressed);
    const bytes = e.method === 0
      ? data
      : new Uint8Array(
          await new Response(
            new Response(data).body!.pipeThrough(new DecompressionStream("deflate-raw"))
          ).arrayBuffer()
        );
    // Flattened: "GeneGA.Rcheck/00check.log" and "tests/testthat.Rout.fail" are
    // unambiguous by basename, and the .Rcheck prefix is just the package name.
    logs[e.name.split("/").pop()!] = new TextDecoder().decode(bytes);
  }
  return logs;
}

// Same contract as captureLog.
export async function captureCheck(
  bucket: R2Bucket, universe: string, job: string, artifact: string, token: string, f: typeof fetch,
): Promise<boolean> {
  const logs = await fetchCheckLogs(universe, artifact, token, f);
  if (!logs || !Object.keys(logs).length) return false;
  await bucket.put(`checks/${universe}/${job}.json`, JSON.stringify(logs), {
    httpMetadata: { contentType: "application/json" },
  });
  return true;
}

// ---------- build manifest ----------
// The job log is the only place a build's inputs are written down: the image it
// ran in, and the resolved version of every dependency it installed. Nothing else
// has them — r-universe's _rundeps is names without versions, and the check
// artifact records only the R revision and the OS. That makes this the difference
// between "the check failed" and "the check can be re-run", since a check that
// broke without the package changing broke because a dependency moved.
//
// Bioconductor's build system publishes the equivalent per builder as
// R-instpkgs.html — and 404s it as soon as a release is archived, so the versions
// behind an archived report are already unrecoverable there.
//
// Extracted once at capture rather than left in place, because the alternative is
// every consumer regexing a log that runs to 9MB.
export type BuildManifest = { image?: string; repos: string[]; deps: Record<string, string> };

export function buildManifest(log: string): BuildManifest {
  // Name and digest are captured independently: a job pulls one image, and the
  // "Digest:" line docker prints does not repeat the name next to it.
  const image = /((?:ghcr|docker)\.io\/[a-z0-9._\-/]+):[a-z0-9._-]+/i.exec(log)?.[1];
  const digest = /Digest: (sha256:[a-f0-9]{64})/.exec(log)?.[1];
  // Windows and macOS jobs run on GitHub-hosted runners rather than in a
  // container, so there is no digest to pin. The runner image name and version
  // are the closest equivalent GitHub publishes, and without this half the jobs
  // would record no environment at all.
  const runner = /\bImage: (\S+)[\s\S]{0,400}?\bVersion: (\S+)/.exec(log);
  const deps: Record<string, string> = {};
  const repos = new Set<string>();
  // Dependencies arrive as plain package downloads, so each URL carries both the
  // resolved version and the repo it resolved from. The repo matters on its own:
  // p3m's ".../latest" is a moving snapshot, so it pins nothing and the versions
  // here are the only record of what "latest" meant that day.
  //
  // All three layouts, because only Linux installs from source. Windows and macOS
  // pull binaries out of bin/{windows,macosx}/…/contrib/{r}/ as .zip and .tgz, and
  // matching src/contrib alone missed 52% of jobs — the half where a
  // platform-specific failure most needs to know what it was built against.
  for (const m of log.matchAll(
    // The optional directory after contrib/ is the R minor, which only the binary
    // layouts carry: src/contrib/pkg.tar.gz but bin/windows/contrib/4.7/pkg.zip.
    /(https?:\/\/[\w.\-/]+?)\/(?:src|bin)\/[\w.\-/]*?contrib\/(?:[\w.]+\/)?([A-Za-z][\w.]*)_([0-9][\w.\-]*)\.(?:tar\.gz|tgz|zip)/g
  )) {
    repos.add(m[1]);
    deps[m[2]] = m[3];
  }
  const pin = image && digest ? `${image}@${digest}` : runner ? `${runner[1]}@${runner[2]}` : undefined;
  return { ...(pin ? { image: pin } : {}), repos: [...repos].sort(), deps };
}

// ---------- zip central directory ----------
// A zip's index sits at the END of the file, which is what makes fetching part of
// one possible: read the last slab, find the end-of-central-directory record, and
// every entry's name, size and byte offset falls out without touching the rest. A
// GHA check artifact is up to 7.6MB of built package tarball wrapped around ~65KB
// of logs, and the logs are the only part worth keeping.
//
// ponytail: no zip64. Offsets go 0xFFFFFFFF past 4GB or 65,535 entries, and these
// artifacts are single-digit MB with under ten files. Add it if that ever changes.
export type ZipEntry = { name: string; method: number; compressed: number; size: number; offset: number };

// `tailStart` is the absolute offset `tail` begins at, so a directory that fell
// outside the slab can be detected rather than misread. Null means "fetch more".
export function parseZipCentral(tail: Uint8Array, tailStart: number): ZipEntry[] | null {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const u16 = (p: number) => dv.getUint16(p, true);
  const u32 = (p: number) => dv.getUint32(p, true);
  let eocd = -1;
  // Scanning backwards finds the real record first when a stored file happens to
  // contain the signature bytes.
  for (let p = tail.length - 22; p >= 0; p--)
    if (u32(p) === 0x06054b50) { eocd = p; break; }
  if (eocd < 0) return null;
  const cdSize = u32(eocd + 12);
  const start = u32(eocd + 16) - tailStart;
  if (start < 0 || start + cdSize > tail.length) return null;
  const entries: ZipEntry[] = [];
  const dec = new TextDecoder();
  let p = start;
  while (p + 46 <= start + cdSize && u32(p) === 0x02014b50) {
    const n = u16(p + 28);
    entries.push({
      name: dec.decode(tail.subarray(p + 46, p + 46 + n)),
      method: u16(p + 10),
      compressed: u32(p + 20),
      size: u32(p + 24),
      offset: u32(p + 42),
    });
    p += 46 + n + u16(p + 30) + u16(p + 32); // + extra field + comment
  }
  return entries;
}

// Everything that is not the built package. The tarball is ~99% of an artifact's
// bytes and, for anything that propagated, is already in the CAS; the rest is text
// worth keeping whatever upstream adds to it next — today that is 00check.log,
// 00install.out, 00BiocCheck.log, output.log, build.log and the *.Rout transcripts.
export const isLogEntry = (name: string) =>
  !name.endsWith("/") && !/\.(tar\.gz|tgz|zip)$/i.test(name);

// ---------- subrequests ----------
// Workers Paid allows 10,000 subrequests an invocation (limits.subrequests is not set in
// wrangler.jsonc; developers.cloudflare.com/workers/platform/limits, read 2026-11-26), and every
// fetch, every hop of a redirect it follows, and every R2 call counts. Past the limit the Worker
// throws, so a drain is given a budget and stops short of it.
export const SUBREQUESTS = 10_000;
// Left for what the budget cannot see: the database sockets and the drain's own bookkeeping.
export const SUBREQUEST_MARGIN = 500;
// A drain's budget when none is given: the default 50 logs (6 each) and 50 checks (~15 each) fit.
export const DRAIN_SUBREQUESTS = 1_500;
// The most a log can spend (R2 head, the API and its redirect, the put, the manifest's get and
// put), claimed before starting it so it never stops between writing the log and its manifest. A
// check writes only at the end, so one stopped part way leaves nothing behind.
const LOG_SUBREQUESTS = 6;

export class OutOfSubrequests extends Error {}

// `bucket` and `f`, counted against `cap`: a call that would pass it throws OutOfSubrequests
// instead of being made.
// ponytail: a followed redirect is charged as two subrequests; GitHub's and r2.ropensci.org's
// are one hop. Charge more if a longer chain ever shows up.
export function metered(bucket: R2Bucket, f: typeof fetch, cap = Infinity) {
  let used = 0;
  const take = (n: number) => {
    if (used + n > cap) throw new OutOfSubrequests(`subrequest budget of ${cap} spent`);
    used += n;
  };
  return {
    bucket: new Proxy(bucket, {
      get(t, p) {
        const v = Reflect.get(t, p);
        return typeof v === "function" ? async (...a: unknown[]) => { take(1); return v.apply(t, a); } : v;
      },
    }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      take(init?.redirect === "manual" ? 1 : 2);
      return f(input, init);
    }) as typeof fetch,
    used: () => used,
    left: () => cap - used,
  };
}

// ---------- the queue ----------

export const captureKey = (kind: "log" | "check", universe: string, job: string) =>
  kind === "log" ? `logs/${universe}/${job}.txt` : `checks/${universe}/${job}.json`;

type Claimed = { builder: string; universe: string; job: string; kind: "log" | "check"; artifact: string | null };
type Counts = { done: number; gone: number; present: number };
export type DrainResult =
  | { status: "skipped"; reason: string }
  | (Counts & { status: "drained" })
  | (Counts & { status: "stopped"; stopped: { universe: string; job: string; kind: string; error: string } })
  | (Counts & { status: "out_of_subrequests"; released: number });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Due rows of one kind, soonest upstream expiry first, leased to this drain for ten minutes so a
// concurrent drain skips them. Every later write to a row requires the drain's lease and a
// pending status, so a drain that outlived its lease, after another drain or an import settled
// the row, changes nothing.
// ponytail: a lease, not a transaction held across the GitHub calls; a drain that dies leaves
// its rows to whichever drain runs after the lease.
async function claim(sql: Sql, lease: string, kind: "log" | "check", n: number): Promise<Claimed[]> {
  const rows = await sql`update capture_queue q set lease = ${lease}, next_attempt_at = now() + interval '10 minutes'
    from (select builder, universe, job, kind from capture_queue
      where status = 'pending' and builder = 'r-universe' and kind = ${kind} and next_attempt_at <= now()
      order by expires_at nulls last, next_attempt_at limit ${n} for update skip locked) c
    where (q.builder, q.universe, q.job, q.kind) = (c.builder, c.universe, c.job, c.kind)
    returning q.builder, q.universe, q.job::text as job, q.kind, q.artifact, q.expires_at`;
  const due = (r: { expires_at?: Date | null }) => (r.expires_at ? +r.expires_at : Infinity);
  return [...rows].sort((a, b) => due(a) - due(b)) as unknown as Claimed[];
}

// At most `logs` logs and `checks` checks, within `budget` subrequests. Saved: done. Already in
// BUCKET (the operator copied the current registry's captures in): done, without asking GitHub.
// Gone upstream: gone. Any other failure, a rate limit included, stops the drain: that row backs
// off (15 minutes doubling per attempt, at most a day) and the rest of the batch is released for
// the next drain. The budget running out releases what is left too, without counting an attempt.
export async function drain(
  env: Pick<Env, "BUCKET" | "GITHUB_TOKEN">, sql: Sql,
  opts: { logs?: number; checks?: number; budget?: number; fetch?: typeof fetch } = {},
): Promise<DrainResult> {
  // Trimmed because the obvious way to set this secret — piping `gcloud secrets
  // versions access` into `wrangler secret put` — stores the trailing newline,
  // and a header value containing one throws "Invalid header value" on every fetch.
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) return { status: "skipped", reason: "no GITHUB_TOKEN" };
  const m = metered(env.BUCKET, opts.fetch ?? fetch, opts.budget ?? DRAIN_SUBREQUESTS);
  const lease = crypto.randomUUID();
  const batch = [
    ...await claim(sql, lease, "log", opts.logs ?? LOGS_PER_TICK),
    ...await claim(sql, lease, "check", opts.checks ?? CHECKS_PER_TICK),
  ];
  const n = { done: 0, gone: 0, present: 0 };
  // What this drain still holds, back to due now.
  const release = async () => (await sql`update capture_queue set lease = null, next_attempt_at = now()
    where lease = ${lease} and status = 'pending'`).count;
  for (const c of batch) {
    const mine = sql`builder = ${c.builder} and universe = ${c.universe} and job = ${c.job} and kind = ${c.kind}
      and lease = ${lease} and status = 'pending'`;
    if (c.kind === "log" && m.left() < LOG_SUBREQUESTS)
      return { status: "out_of_subrequests", ...n, released: await release() };
    try {
      const saved = await m.bucket.head(captureKey(c.kind, c.universe, c.job)) ? "present"
        : c.kind === "log" ? await captureLog(m.bucket, c.universe, c.job, token, m.fetch) && "done"
        : c.artifact !== null && await captureCheck(m.bucket, c.universe, c.job, c.artifact, token, m.fetch) && "done";
      await sql`update capture_queue set status = ${saved ? "done" : "gone"}, done_at = now(), last_error = null,
        lease = null where ${mine}`;
      n[saved || "gone"]++;
    } catch (e) {
      if (e instanceof OutOfSubrequests) return { status: "out_of_subrequests", ...n, released: await release() };
      const error = message(e);
      await sql`update capture_queue set attempts = attempts + 1, last_error = ${error}, lease = null,
        next_attempt_at = now() + least(interval '15 minutes' * power(2, least(attempts, 7)), interval '1 day')
        where ${mine}`;
      await release();
      return { status: "stopped", ...n, stopped: { universe: c.universe, job: c.job, kind: c.kind, error } };
    }
  }
  return { status: "drained", ...n };
}
