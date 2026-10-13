// Local test/demo backend only: real PostgreSQL migrations and RLS, stubbed Supabase-owned schemas.
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
export const salesId = "11111111-1111-4111-8111-111111111111";
export const adminId = "22222222-2222-4222-8222-222222222222";
export const opsId = "33333333-3333-4333-8333-333333333333";
export const financeId = "44444444-4444-4444-8444-444444444444";
export async function orderDatabase({phase7=true,scanFit=false,clientScan=false}={}) {
  const db = new PGlite({ parsers: { 1700: Number, 1082: (value) => value } });
  await db.exec(`
create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
alter default privileges in schema public grant all on tables to anon,authenticated;
alter default privileges in schema public grant all on sequences to anon,authenticated;
alter default privileges in schema public grant execute on functions to anon,authenticated;
create table auth.users(id uuid primary key,email text,encrypted_password text,last_sign_in_at timestamptz,raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text,metadata jsonb default '{}');
create function storage.foldername(name text) returns text[] language sql as $$select string_to_array(name,'/')$$;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;grant all on storage.objects to authenticated;
`);
  for (const file of [
    "202609270001_foundation_customers.sql",
    "202609270002_orders.sql",
    "202609270003_loupe_catalogue.sql",
    "202609270004_prescription_attachments.sql",
    "202609270005_frame_options.sql",
    "202609270006_order_hub.sql",
    "202609280007_staff_auth.sql",
    "202609280008_financial_controls.sql",
    "202609280009_system_health.sql",
    "202609280010_core_refinements.sql",
    "202609280011_invoices.sql",
    "202609290012_secure_media.sql",
    "202609290013_document_packages.sql",
    "202609290014_media_prescription_bridge.sql",
    "202609300015_elevate_products.sql",
    "202609300016_reporting.sql",
    "202610010017_scoped_settings_updates.sql",
  ].filter(file => phase7 || !file.startsWith("2026093000")))
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  if(scanFit) await db.exec(await readFile(new URL("../supabase/migrations/202610130018_scan_fit.sql",import.meta.url),"utf8"));
  if(clientScan) await db.exec(await readFile(new URL("../supabase/migrations/202610130019_scan_fit_client_links.sql",import.meta.url),"utf8"));
  for (const [id, role] of [
    [salesId, "sales"],
    [adminId, "administrator"],
    [opsId, "operations"],
    [financeId, "finance"],
  ]) {
    await db.query("insert into auth.users(id) values($1)", [id]);
    await db.query(
      "update public.users set active=true,full_name=$2,role=$3::public.staff_role where id=$1",
      [id, role === "sales" ? "Alex Morgan" : role, role],
    );
  }
  const request = async (sql, args = [], id = /** @type {string|null} */ (salesId)) =>
    db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [
        id,
      ]);
      await tx.exec(
        id ? "set local role authenticated" : "set local role anon",
      );
      return (await tx.query(sql, args)).rows;
    });
  return { db, request };
}
