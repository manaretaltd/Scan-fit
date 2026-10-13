import assert from "node:assert/strict";
import {
  orderDatabase,
  adminId,
  salesId,
  opsId,
  financeId,
} from "./order-backend.mjs";

const { db, request } = await orderDatabase();
const media = {
  image_limit: 20 * 1048576,
  pdf_limit: 20 * 1048576,
  video_limit: 50 * 1048576,
  manufacturer_name: "TEST manufacturer",
  manufacturer_email: "factory@example.test",
};
const company = {
  legal_name: "TEST Company",
  address: "TEST address",
  company_number: "TEST123",
  registration_country: "TEST",
  email: "test@example.test",
  currency: "GBP",
  invoice_prefix: "TEST-INV",
  vat_registered: false,
  default_vat_rate: "0",
};
const cases = [
  {
    name: "configure_media",
    table: "media_settings",
    sql: "select public.configure_media($1::jsonb)",
    args: [JSON.stringify(media)],
  },
  {
    name: "save_company_settings",
    table: "company_settings",
    sql: "select public.save_company_settings($1::jsonb,true)",
    args: [JSON.stringify(company)],
  },
  {
    name: "configure_finance",
    table: "finance_settings",
    sql: "select public.configure_finance($1)",
    args: ["full"],
  },
];

try {
  // PGlite does not ship pg_safeupdate; check the deployed function definitions
  // as well as exercising the permission, persistence and audit behavior below.
  for (const c of cases) {
    const { rows } = await db.query<{ definition: string }>(
      "select pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",
      [c.name],
    );
    assert.equal(rows.length, 1);
    assert.match(
      rows[0].definition,
      new RegExp(`update public\\.${c.table}[^;]*where id\\s*=\\s*true`, "i"),
    );
    for (const actor of [salesId, opsId, financeId, null]) {
      await assert.rejects(
        () => request(c.sql, c.args, actor),
        /permission denied|Access denied|Permission denied/i,
      );
    }
    await request(c.sql, c.args, adminId);
    const audit = (
      await db.query<{
        user_id: string;
        previous_value: Record<string, unknown>;
        new_value: Record<string, unknown>;
      }>(
        "select user_id,previous_value,new_value from public.audit_logs where entity_type=$1 and action='UPDATE' order by id desc limit 1",
        [c.table],
      )
    ).rows[0];
    assert.equal(audit.user_id, adminId);
    assert.ok(audit.previous_value);
    assert.equal(audit.new_value.id, true);
    console.log(
      `PASS ${c.name}: scoped update, administrator-only access and attributed audit`,
    );
  }
  assert.equal(
    (
      await db.query<{ video_limit: number }>(
        "select video_limit from public.media_settings",
      )
    ).rows[0].video_limit,
    media.video_limit,
  );
  const savedCompany = (
    await db.query<{
      details: unknown;
      verified_by: string;
      verified_at: unknown;
    }>("select details,verified_by,verified_at from public.company_settings")
  ).rows[0];
  assert.deepEqual(savedCompany.details, company);
  assert.equal(savedCompany.verified_by, adminId);
  assert.ok(savedCompany.verified_at);
  assert.equal(
    (
      await db.query<{ manufacturer_requirement: string }>(
        "select manufacturer_requirement from public.finance_settings",
      )
    ).rows[0].manufacturer_requirement,
    "full",
  );
  const before = (
    await db.query("select count(*) count from public.audit_logs")
  ).rows;
  await assert.rejects(
    () =>
      request(
        cases[0].sql,
        [JSON.stringify({ ...media, video_limit: 999999999 })],
        adminId,
      ),
    /check constraint/,
  );
  await assert.rejects(
    () =>
      request(
        cases[1].sql,
        [JSON.stringify({ ...company, address: "" })],
        adminId,
      ),
    /incomplete/,
  );
  await assert.rejects(
    () => request(cases[2].sql, ["invalid"], adminId),
    /check constraint/,
  );
  assert.deepEqual(
    (await db.query("select count(*) count from public.audit_logs")).rows,
    before,
  );
  console.log(
    "PASS invalid settings roll back without an audit or data change",
  );
  await request(
    "select public.save_company_settings($1::jsonb,false)",
    [JSON.stringify({ ...company, address: "Updated test address" })],
    adminId,
  );
  assert.equal(
    (
      await db.query<{ verified_by: string | null }>(
        "select verified_by from public.company_settings",
      )
    ).rows[0].verified_by,
    null,
  );
  console.log(
    "PASS editing unverified company details clears prior verification",
  );
} finally {
  await db.close();
}
