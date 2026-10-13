import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
// Real PostgreSQL engine with small stubs for Supabase-owned schemas. No HTTP/Auth/Storage emulation.
const db = new PGlite();
let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  await run();
  checks++;
  console.log(`PASS ${name}`);
}
async function query<T>(sql: string, args: unknown[] = []) {
  return (await db.query<T>(sql, args)).rows;
}
const sales = "11111111-1111-4111-8111-111111111111",
  admin = "22222222-2222-4222-8222-222222222222",
  ops = "33333333-3333-4333-8333-333333333333",
  finance = "44444444-4444-4444-8444-444444444444";
async function asUser(id: string) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec("set role authenticated");
}
const payload = {
  first_name: "Ada",
  last_name: "Dentist",
  email: "ada@example.test",
  mobile: "+44 7700 900123",
  practice_name: "Example Dental",
  status: "Lead",
  preferred_contact: "Email",
  lead_source: "Website",
  notes: "Met at dental show",
};
async function save(
  p: object = payload,
  addresses: object[] = [],
  id: string | null = null,
  override = false,
) {
  return (
    await query<{ result: { id?: string; duplicates?: unknown[] } }>(
      "select public.save_customer($1::jsonb,$2::jsonb,$3::uuid,$4) result",
      [JSON.stringify(p), JSON.stringify(addresses), id, override],
    )
  )[0].result;
}
try {
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
 alter default privileges in schema public grant all on tables to anon,authenticated;
 alter default privileges in schema public grant all on sequences to anon,authenticated;
 alter default privileges in schema public grant execute on functions to anon,authenticated;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
 create function storage.foldername(name text) returns text[] language sql as $$select string_to_array(name,'/')$$;
 alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated;grant all on storage.objects to authenticated;
 `);
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/202609270001_foundation_customers.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.query("insert into auth.users(id) values ($1),($2),($3),($4)", [
    sales,
    admin,
    ops,
    finance,
  ]);
  await db.query(
    "update public.users set active=true,role=case id when $1 then 'administrator'::public.staff_role when $2 then 'operations'::public.staff_role when $3 then 'finance'::public.staff_role else 'sales'::public.staff_role end",
    [admin, ops, finance],
  );
  await asUser(sales);
  let customerId = "";
  await check(
    "sales can create dentist and both addresses atomically",
    async () => {
      const result = await save(payload, [
        {
          kind: "Practice",
          line1: "1 Test Road",
          city: "London",
          country: "United Kingdom",
        },
        {
          kind: "Delivery",
          line1: "2 Test Road",
          city: "London",
          country: "United Kingdom",
        },
      ]);
      customerId = result.id!;
      assert.ok(customerId);
      assert.equal(
        (await query("select * from public.customer_addresses")).length,
        2,
      );
    },
  );
  await check(
    "find dentist by name, email, normalized phone, practice and ID",
    async () => {
      const [{ customer_number }] = await query<{ customer_number: number }>(
        "select customer_number from public.customers",
      );
      for (const term of [
        "Ada",
        "ada@example.test",
        "07700900123",
        "Example Dental",
        `ES-${customer_number}`,
      ])
        assert.equal(
          (await query("select * from public.search_customers($1)", [term]))
            .length,
          1,
        );
      assert.equal(
        (await query("select * from public.search_customers('','Customer')"))
          .length,
        0,
      );
      assert.equal(
        (await query("select * from public.search_customers('%,)')")).length,
        0,
      );
    },
  );
  await check(
    "email, UK phone and exact name+practice duplicates warn; override is explicit",
    async () => {
      for (const p of [
        { ...payload, first_name: "Other" },
        {
          ...payload,
          email: "other@example.test",
          mobile: "07700 900123",
          first_name: "Other",
        },
        { ...payload, email: "", mobile: "" },
      ])
        assert.ok((await save(p)).duplicates?.length);
      assert.equal((await query("select * from public.customers")).length, 1);
      assert.ok((await save(payload, [], null, true)).id);
    },
  );
  await check("edit customer and address replacement persist", async () => {
    await save(
      { ...payload, job_title: "Principal dentist" },
      [
        {
          kind: "Practice",
          line1: "3 Updated Road",
          country: "United Kingdom",
        },
      ],
      customerId,
    );
    assert.equal(
      (
        await query<{ job_title: string }>(
          "select job_title from public.customers where id=$1",
          [customerId],
        )
      )[0].job_title,
      "Principal dentist",
    );
    assert.equal(
      (
        await query(
          "select * from public.customer_addresses where customer_id=$1",
          [customerId],
        )
      ).length,
      1,
    );
  });
  await check("invalid address rolls back customer changes", async () => {
    await assert.rejects(() =>
      save(
        { ...payload, first_name: "Should rollback" },
        [{ kind: "Invalid", line1: "Road" }],
        customerId,
      ),
    );
    assert.equal(
      (
        await query<{ first_name: string }>(
          "select first_name from public.customers where id=$1",
          [customerId],
        )
      )[0].first_name,
      "Ada",
    );
  });
  await check("add activity, task and secure file metadata", async () => {
    await db.query(
      "insert into public.activities(customer_id,type,description) values($1,'Note','Discussed next appointment')",
      [customerId],
    );
    await db.query(
      "insert into public.tasks(customer_id,title,assigned_to,due_date) values($1,'Call dentist',$2,'2026-10-01')",
      [customerId, sales],
    );
    await db.query(
      "insert into storage.objects(bucket_id,name,owner_id) values('customer-files',$1,$2)",
      [`${customerId}/example.pdf`, sales],
    );
    await db.query(
      "insert into public.files(customer_id,filename,mime_type,size_bytes,category,storage_path) values($1,'example.pdf','application/pdf',100,'Customer',$2)",
      [customerId, `${customerId}/example.pdf`],
    );
    await db.exec("update public.tasks set completed=true");
    assert.equal(
      (
        await query<{ completed: boolean }>(
          "select completed from public.tasks",
        )
      )[0].completed,
      true,
    );
  });
  await check(
    "private storage rejects unknown customers and protects registered files",
    async () => {
      await assert.rejects(() =>
        db.query(
          "insert into storage.objects(bucket_id,name,owner_id) values('customer-files',$1,$2)",
          ["99999999-9999-4999-8999-999999999999/invalid.pdf", sales],
        ),
      );
      await db.query("delete from storage.objects where name=$1", [
        `${customerId}/example.pdf`,
      ]);
      assert.equal((await query("select * from storage.objects")).length, 1);
      await db.query(
        "insert into storage.objects(bucket_id,name,owner_id) values('customer-files',$1,$2)",
        [`${customerId}/orphan.pdf`, sales],
      );
      await db.query("delete from storage.objects where name=$1", [
        `${customerId}/orphan.pdf`,
      ]);
      assert.equal((await query("select * from storage.objects")).length, 1);
      assert.equal(
        (
          await query(
            "select * from public.activities where type='File uploaded'",
          )
        ).length,
        1,
      );
    },
  );
  await check(
    "forged activity author and task author edits are denied",
    async () => {
      await assert.rejects(() =>
        db.query(
          "insert into public.activities(customer_id,type,description,user_id) values($1,'Note','Forged',$2)",
          [customerId, admin],
        ),
      );
      await assert.rejects(() =>
        db.query("update public.tasks set created_by=$1", [admin]),
      );
    },
  );
  await check(
    "sales cannot change roles, grant permissions, or modify audit history",
    async () => {
      await assert.rejects(() =>
        db.exec("update public.users set role='administrator'"),
      );
      await assert.rejects(() =>
        db.exec(
          "insert into public.role_permissions values('sales','staff.manage')",
        ),
      );
      await assert.rejects(() => db.exec("delete from public.audit_logs"));
      assert.equal((await query("select * from public.audit_logs")).length, 0);
    },
  );
  await check(
    "operations and finance see customers but cannot write CRM or read private attachments",
    async () => {
      for (const id of [ops, finance]) {
        await asUser(id);
        assert.equal((await query("select * from public.customers")).length, 2);
        assert.equal(
          (await query("select * from public.activities")).length,
          0,
        );
        assert.equal((await query("select * from public.files")).length, 0);
        assert.equal((await query("select * from storage.objects")).length, 0);
        await assert.rejects(() => save());
      }
    },
  );
  await check(
    "administrator can inspect audit and deactivate staff; self-demotion denied",
    async () => {
      await asUser(admin);
      assert.ok((await query("select * from public.audit_logs")).length > 10);
      await assert.rejects(() =>
        db.query("select public.update_staff($1,'sales',false)", [admin]),
      );
      await db.query("select public.update_staff($1,'sales',false)", [sales]);
    },
  );
  await check(
    "deactivation revokes reads, writes and private storage with existing identity",
    async () => {
      await asUser(sales);
      assert.equal((await query("select * from public.customers")).length, 0);
      assert.equal((await query("select * from storage.objects")).length, 0);
      await assert.rejects(() => save());
    },
  );
  await check(
    "anonymous cannot access customers or customer RPCs",
    async () => {
      await db.exec("reset role;set role anon");
      await assert.rejects(() => query("select * from public.customers"));
      await assert.rejects(() => save());
    },
  );
  console.log(`\n${checks} database integration checks passed.`);
} finally {
  await db.close();
}
