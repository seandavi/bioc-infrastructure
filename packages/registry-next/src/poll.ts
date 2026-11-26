// The sweep: r-universe's package records for one universe, archived to BUCKET when they changed
// and recorded in observations. The body is hashed and stored, never parsed here: a snapshot is
// ~30 MB, and observe() parses it once.
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Env } from "./db.ts";

// Build-relevant fields only: full body is ~70MB and includes volatile fields
// (_score, _stars) that would make the digest churn on every poll.
// _failure: when a newer commit fails, the main record keeps showing the last
// successful build — the failure is ONLY visible in this field.
// The unprefixed fields ARE the parsed DESCRIPTION and feed PACKAGES directly —
// except the dependency fields, which r-universe normalises out of the top level
// into _dependencies [{package, version, role}]. Priority/OS_type are usually
// absent (only set when the DESCRIPTION sets them); requesting them is harmless.
// NB: adding fields changes the digest, so the first poll after this re-archives
// and re-fires every universe once.
export const FIELDS =
  "Version,License,NeedsCompilation,Priority,OS_type,_dependencies,_file," +
  "_sha256,_status,_jobs,_created,_expires,_fileid,_binaries,_commit,_failure,_buildurl," +
  // Descriptive metadata for VIEWS and the site's landing pages. All of these
  // change only when the package itself changes, so the digest stays quiet.
  "Title,Description,Author,Maintainer,URL,BugReports,SystemRequirements,Date," +
  "biocViews,VignetteBuilder,_vignettes," +
  // What it takes to reproduce a check, and what the check artifact does not say.
  // _sysdeps carries system library versions (libtbb12 2022.3.0-2, …), _distro the
  // builder's Ubuntu codename, and RemoteUrl/Ref/Sha the exact source pin — the
  // 40-char sha, where _commit.id is abbreviated. Bioconductor's build system
  // publishes the equivalent as NodeInfo + R-instpkgs, and drops R-instpkgs the
  // moment a release is archived, so mirroring it here is the whole point.
  "_sysdeps,_distro,RemoteUrl,RemoteRef,RemoteSha," +
  // _devurl is the maintainer's actual development repository (present for 1,432
  // of 2,419), as opposed to git_url's read-only github.com/bioc mirror. It is the
  // only field here that says where a fix could be sent.
  "_upstream,_devurl," +
  // _bioccheck is BiocCheck's counts — {error, warning, note} — where the index's
  // own bioccheck is just the job's pass/fail verdict.
  "_bioccheck,_bioc,_filesize,_cranurl,Config/Bioconductor/UnsupportedPlatforms";
// Deliberately excluded: _downloads and _score change continuously, so they would
// make every poll a fresh digest and turn ~16 observations a day into 96. _help
// (29MB) and _exports (5.8MB) would more than double the observation to archive
// what an MCP server can ask r-universe for at query time.

export type PollResult = { status: "unchanged" | "archived"; digest: string; key?: string };

// Unchanged when the body hashes to the universe's newest observation. A body that reverts to an
// older observation's digest is archived again and that row reset to it, so observe() re-plans
// from it and records its jobs as the newest.
export async function poll(env: Pick<Env, "BUCKET">, sql: Sql, universe: string, f: typeof fetch = fetch): Promise<PollResult> {
  const res = await f(`https://${universe}.r-universe.dev/api/packages?limit=100000&fields=${FIELDS}`);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${universe}: HTTP ${res.status}`);
  }
  const body = new Uint8Array(await res.arrayBuffer());
  const digest = createHash("sha256").update(body).digest("hex");
  const [newest] = await sql`select digest from observations where universe = ${universe}
    order by obs_ts desc, seen_at desc limit 1`;
  if (newest?.digest === digest) return { status: "unchanged", digest };
  const ts = new Date().toISOString();
  // The current registry's key shape, so its archive copies into the same prefix.
  const key = `obs/${universe}/dt=${ts.slice(0, 10)}/${ts}-${digest.slice(0, 12)}.json`;
  await env.BUCKET.put(key, body, { httpMetadata: { contentType: "application/json" } });
  await sql`insert into observations (universe, digest, obs_ts, r2_key) values (${universe}, ${digest}, ${ts}, ${key})
    on conflict (universe, digest) do update set obs_ts = excluded.obs_ts, r2_key = excluded.r2_key,
      seen_at = now(), processed_at = null, recorded_at = null`;
  return { status: "archived", digest, key };
}
