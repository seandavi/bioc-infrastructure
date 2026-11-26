import postgres from "postgres";
import type { Sql } from "postgres";

// Bindings. LEGACY is the current registry's bucket, read by nothing here any more: the
// operator's one-time copy replaced it, and the binding is removed next. Typed without
// put/delete so nothing here can write to it.
export type Env = {
  HYPERDRIVE: { connectionString: string };
  BUCKET: R2Bucket;
  LEGACY?: Pick<R2Bucket, "get" | "head" | "list">;
  MAINT_KEY?: string;
  // Read-only GitHub token for job logs and check artifacts (capture.ts). Optional: without it
  // nothing is captured.
  GITHUB_TOKEN?: string;
};

// A Worker request may hold six connections open at once, and database sockets, R2 reads and R2
// writes all count. A copy holds its read open while it waits to open its write, so when idle
// sockets and reads in progress fill all six, no write can start and the request never ends.
// Two sockets plus the copies run at once (COPIES in observe.ts) must stay under six, which
// leaves one write its slot; a test holds the sum there.
export const DB_SOCKETS = 2;

// One client per request: Workers cannot share a socket between requests, and Hyperdrive
// does the pooling. fetch_types saves a round trip per connection; no query here needs it.
export const connect = (env: Pick<Env, "HYPERDRIVE">): Sql =>
  postgres(env.HYPERDRIVE.connectionString, { max: DB_SOCKETS, fetch_types: false, onnotice() {} });
