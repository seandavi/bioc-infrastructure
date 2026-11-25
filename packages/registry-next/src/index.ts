import { createHash, timingSafeEqual } from "node:crypto";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import type { Sql } from "postgres";
import { connect } from "./db.ts";
import type { Env } from "./db.ts";
import { gate } from "./gate.ts";
import type { GateConfig } from "./gate.ts";
import { migrate } from "./migrations.ts";
import { biocVersion, casDoc, packageDoc, published } from "./store.ts";

// The OpenAPI document is generated from these route definitions, so it cannot drift from them.
// A request that fails its schema gets {error} and a 400, as the current registry answers.
const app = new OpenAPIHono<{ Bindings: Env; Variables: { sql: Sql } }>({
  defaultHook: (r, c) => {
    if (!r.success)
      return c.json({ error: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
  },
});

// A client per request, closed after the response. Connecting is lazy, so a route that
// never queries costs nothing.
app.use(async (c, next) => {
  const sql = connect(c.env);
  c.set("sql", sql);
  try {
    await next();
  } finally {
    const done = sql.end({ timeout: 5 });
    try {
      c.executionCtx.waitUntil(done);
    } catch {
      await done; // no ExecutionContext under app.request() in tests
    }
  }
});

// Everything that writes needs the maintenance key. Unset means closed, not open.
const sha = (s: string) => createHash("sha256").update(s).digest();
app.use("/admin/*", async (c, next) => {
  const key = c.env.MAINT_KEY;
  if (!key || !timingSafeEqual(sha(c.req.header("x-maint-key") ?? ""), sha(key)))
    return c.json({ error: "forbidden" }, 403);
  await next();
});

// The public routes are readable from any page.
for (const path of ["/", "/openapi.json", "/gate", "/api/*"]) app.use(path, cors());

app.get("/", (c) => c.json({ service: "bioc-registry-next", status: "shadow" }));

app.post("/admin/migrate", async (c) => c.json({ applied: await migrate(c.get("sql")) }));

app.doc("/openapi.json", {
  openapi: "3.0.0",
  info: { title: "bioc-registry-next", version: "0", description: "The shadow Bioconductor registry (#213)." },
});

const REPOS = ["bioc", "data/annotation", "data/experiment", "workflows"] as const;
const VERSION = z.string().regex(/^(\d+\.\d+|release|devel)$/)
  .openapi({ description: "A Bioconductor version, or release or devel", example: "3.24" });
const Err = z.object({ error: z.string() });
const json = <T extends z.ZodType>(schema: T, description: string) =>
  ({ content: { "application/json": { schema } }, description });

// A numbered version as given, or the one a role currently names; undefined for a role that
// no version holds.
async function resolve(sql: Sql, v: string) {
  const row = await biocVersion(sql, v);
  return { bioc_version: row?.bioc_version ?? (/^\d/.test(v) ? v : undefined), r_minor: row?.r_minor };
}

// ---------- POST /gate ----------

const Job = z.object({ config: z.string(), r: z.string().optional(), check: z.string().optional() });
const Candidate = z.object({
  package: z.string(), version: z.string(), jobs: z.array(Job),
  origin: z.enum(["r-universe", "bioconductor", "bioc-build"]).default("r-universe"),
  build_status: z.string().default("success"),
  desc: z.record(z.string(), z.string()).default({})
    .openapi({ description: "DESCRIPTION dependency and license fields" }),
  manifest: z.object({
    state: z.string().optional(), git_url: z.string().optional(), streams: z.array(z.string()).optional(),
    component: z.string().optional(), profile: z.string().optional(),
  }).nullable().optional()
    .openapi({ description: "absent: manifest rules do not run; null: the lookup failed" }),
  source_git_url: z.string().optional(), stream: z.string().optional(),
});
const Decision = z.object({
  propagate: z.boolean(), archs: z.array(z.string()),
  reasons: z.array(z.object({ rule: z.string(), ok: z.boolean(), detail: z.string().optional() })),
});

app.openapi(createRoute({
  method: "post", path: "/gate",
  summary: "Would these candidates propagate, and if not why. Read-only.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            bioc_version: VERSION, repo: z.enum(REPOS),
            candidates: z.array(Candidate).min(1).max(500),
            config: z.object({
              gating_r: z.string().optional()
                .openapi({ description: "defaults to the R line config.yaml maps the version to" }),
              bioccheck: z.enum(["advisory", "blocking"]).optional(),
              replace_seed: z.boolean().optional(),
            }).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: json(z.object({
      config: z.object({ gating_r: z.string(), bioccheck: z.enum(["advisory", "blocking"]), replace_seed: z.boolean() }),
      decisions: z.record(z.string(), Decision),
      approved: z.array(z.string()).openapi({ description: "in dependency order" }),
    }), "One decision per candidate"),
    400: json(Err, "Malformed body, or a version with no known R line and no config.gating_r"),
  },
}), async (c) => {
  const body = c.req.valid("json");
  const sql = c.get("sql");
  const v = await resolve(sql, body.bioc_version);
  const gating_r = body.config?.gating_r ?? v.r_minor;
  if (!v.bioc_version || !gating_r)
    return c.json({ error: `unknown bioc_version ${body.bioc_version}; pass config.gating_r` }, 400);
  const config: GateConfig = {
    gating_r,
    bioccheck: body.config?.bioccheck ?? "advisory",
    replace_seed: body.config?.replace_seed ?? true,
  };
  // ponytail: no `known` names yet (CRAN and the data repositories), so a hard dependency
  // nobody publishes passes deps, as the current registry does before its first refresh.
  const result = gate(body.candidates, config, await published(sql, v.bioc_version, body.repo));
  return c.json({ config, ...result }, 200);
});

// ---------- documents ----------

const Doc = z.object({}).passthrough();

// Four literal paths rather than one with a slash-bearing parameter, so the document lists
// each repository as it is addressed.
for (const repo of REPOS)
  app.openapi(createRoute({
    method: "get", path: `/api/v1/packages/{bioc_version}/${repo}/{package}`,
    summary: `One package in ${repo}: its current publication, history and latest gate decisions`,
    request: { params: z.object({ bioc_version: VERSION, package: z.string().regex(/^[A-Za-z][A-Za-z0-9.]*$/) }) },
    responses: { 200: json(Doc, "The package"), 404: json(Err, "Never published here") },
  }), async (c) => {
    const { bioc_version, package: pkg } = c.req.valid("param");
    const sql = c.get("sql");
    const v = await resolve(sql, bioc_version);
    const doc = v.bioc_version && await packageDoc(sql, v.bioc_version, repo, pkg);
    if (!doc) return c.json({ error: "not found" }, 404);
    return c.json(doc, 200);
  });

app.openapi(createRoute({
  method: "get", path: "/api/v1/cas/{sha256}",
  summary: "One stored object and every publication that references it",
  request: { params: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }) },
  responses: { 200: json(Doc, "The object"), 404: json(Err, "Not in the store") },
}), async (c) => {
  const doc = await casDoc(c.get("sql"), c.req.valid("param").sha256);
  if (!doc) return c.json({ error: "not found" }, 404);
  return c.json(doc, 200);
});

export default app;
