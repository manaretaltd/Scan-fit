// One-time SQL Editor bootstrap for a verified empty hosted Supabase project.
// Normal upgrades must use the individual migration files through Supabase CLI.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function initialDatabaseBundle() {
  const root = new URL("../", import.meta.url);
  const dir = new URL("supabase/migrations/", root);
  const files = (await readdir(dir))
    .filter((f) => /^\d+_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  if (files.length !== 19 || !files.at(-1).startsWith("202610130019_"))
    throw new Error("Review the bootstrap before adding new migrations.");
  const manifest = [];
  const parts = [
    "-- Elevate CRM: initial install only; requires an empty Supabase project.",
    "-- All application changes and migration history commit together.",
    "begin;",
    "set local statement_timeout = '120s';",
    "select pg_advisory_xact_lock(829318);",
    `do $preflight$ begin
      if exists(select 1 from pg_tables where schemaname='public')
        or exists(select 1 from auth.users)
        or exists(select 1 from storage.buckets)
        or to_regclass('supabase_migrations.schema_migrations') is not null then
        raise exception 'Initial installation requires an empty project. Use migrations for upgrades.';
      end if;
    end $preflight$;`,
    "create schema if not exists supabase_migrations;",
    "create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text);",
    "revoke all on schema supabase_migrations from public,anon,authenticated;",
    "revoke all on supabase_migrations.schema_migrations from public,anon,authenticated;",
  ];
  for (const filename of files) {
    const source = await readFile(new URL(filename, dir), "utf8");
    const sql = source.trim();
    if (!/^begin;/i.test(sql) || !/commit;$/i.test(sql))
      throw new Error(`Missing outer transaction: ${filename}`);
    // Strip only the file's outer transaction, preserving function bodies.
    const body = sql.replace(/^begin;\s*/i, "").replace(/\s*commit;$/i, "");
    const [, version, name] = filename.match(/^(\d+)_(.+)\.sql$/);
    const delimiter = `$source_${version}$`;
    if (source.includes(delimiter)) throw new Error("SQL delimiter collision.");
    manifest.push({
      filename,
      version,
      name,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
    parts.push(
      `-- ${filename}`,
      body,
      `insert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','${name}',array[${delimiter}${source}${delimiter}]);`,
    );
  }
  parts.push(
    `do $verify$ begin
    if (select count(*) from supabase_migrations.schema_migrations) <> 19 then
      raise exception 'Incomplete migration history';
    end if;
    if exists(select 1 from pg_tables where schemaname='public' and not rowsecurity) then
      raise exception 'An application table is missing RLS';
    end if;
    if exists(select 1 from storage.buckets where public) then
      raise exception 'An attachment bucket is public';
    end if;
  end $verify$;`,
    "commit;",
    `select 'Installation complete' as result,
    (select count(*) from supabase_migrations.schema_migrations) as migrations,
    (select count(*) from pg_tables where schemaname='public') as application_tables,
    (select count(*) from pg_tables where schemaname='public' and rowsecurity) as rls_tables,
    (select count(*) from storage.buckets where not public) as private_buckets;`,
  );
  return { sql: parts.join("\n\n") + "\n", manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { sql, manifest } = await initialDatabaseBundle();
  const output = new URL("../output/deployment/", import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL("initial-database.sql", output), sql);
  await writeFile(
    new URL("initial-database-manifest.json", output),
    JSON.stringify(
      {
        bundle_sha256: createHash("sha256").update(sql).digest("hex"),
        migrations: manifest,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Prepared ${manifest.length} migrations; ${Buffer.byteLength(sql)} bytes. No database connection was made.`,
  );
}
