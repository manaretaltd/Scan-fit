import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { initialDatabaseBundle } from "../scripts/build-initial-database.mjs";

// Reuse exactly the Supabase-owned schema stubs of the existing DB suites.
const backend = await readFile(
  new URL("order-backend.mjs", import.meta.url),
  "utf8",
);
const stub = backend.match(/await db\.exec\(`([\s\S]*?)`\);/)?.[1];
assert.ok(stub, "Supabase test schema stubs exist");
const { sql, manifest } = await initialDatabaseBundle();
const db = new PGlite();
try {
  await db.exec(stub);
  await db.exec(sql);
  const history = (
    await db.query<{ version: string; name: string; statements: string[] }>(
      "select * from supabase_migrations.schema_migrations order by version",
    )
  ).rows;
  assert.equal(history.length, 19);
  for (const [i, m] of manifest.entries()) {
    assert.equal(history[i].version, m.version);
    assert.equal(history[i].name, m.name);
    assert.equal(
      history[i].statements[0],
      await readFile(
        new URL(`../supabase/migrations/${m.filename}`, import.meta.url),
        "utf8",
      ),
    );
  }
  assert.equal(
    (
      await db.query(
        "select tablename from pg_tables where schemaname='public' and not rowsecurity",
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (await db.query("select id from storage.buckets where public")).rows.length,
    0,
  );
  assert.equal((await db.query("select * from public.users")).rows.length, 0);
  console.log(
    "PASS initial bundle applies all 19 migrations, retains original SQL, enables all RLS and creates no staff accounts",
  );
  await assert.rejects(() => db.exec(sql), /empty project/);
  await db.exec("rollback;");
  assert.equal(
    (await db.query("select * from supabase_migrations.schema_migrations")).rows
      .length,
    19,
  );
  console.log(
    "PASS repeat installation is rejected without changing existing data/history",
  );
} finally {
  await db.close();
}
const failed = new PGlite();
try {
  await failed.exec(stub);
  const broken = sql.replace(
    "-- 202610010017_scoped_settings_updates.sql",
    "select 1/0;\n-- 202610010017_scoped_settings_updates.sql",
  );
  await assert.rejects(() => failed.exec(broken), /division by zero/);
  await failed.exec("rollback;");
  assert.equal(
    (
      await failed.query(
        "select tablename from pg_tables where schemaname='public'",
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (await failed.query("select * from storage.buckets")).rows.length,
    0,
  );
  assert.equal(
    (
      await failed.query<{ t: string | null }>(
        "select to_regclass('supabase_migrations.schema_migrations') t",
      )
    ).rows[0].t,
    null,
  );
  console.log(
    "PASS late migration failure rolls back all schema, storage and migration records",
  );
} finally {
  await failed.close();
}
