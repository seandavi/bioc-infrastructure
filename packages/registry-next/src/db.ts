import postgres from "postgres";
import type { Sql } from "postgres";

// Bindings. LEGACY is the current registry's bucket: typed without put/delete so nothing
// here can write to it.
export type Env = {
  HYPERDRIVE: { connectionString: string };
  BUCKET: R2Bucket;
  LEGACY: Pick<R2Bucket, "get" | "head" | "list">;
  MAINT_KEY?: string;
};

// One client per request: Workers cannot share a socket between requests, and Hyperdrive
// does the pooling. fetch_types saves a round trip per connection; no query here needs it.
export const connect = (env: Pick<Env, "HYPERDRIVE">): Sql =>
  postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, onnotice() {} });
