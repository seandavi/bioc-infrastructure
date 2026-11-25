// A fresh database per test file, so files run in parallel against one server. Migrated unless
// the test is of migrating.
import postgres from "postgres";
import { migrate } from "./migrations.ts";

export async function testDb(opts: { migrate?: boolean } = {}) {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set; see README (docker run postgres:18)");
  const name = `t_${process.pid}_${Date.now().toString(36)}`;
  const admin = postgres(base, { max: 1, onnotice() {} });
  await admin.unsafe(`create database ${name}`);
  const u = new URL(base);
  u.pathname = `/${name}`;
  const sql = postgres(u.href, { max: 4, onnotice() {} });
  if (opts.migrate ?? true) await migrate(sql);
  return {
    sql,
    url: u.href,
    async close() {
      await sql.end();
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
