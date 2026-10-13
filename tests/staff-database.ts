import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  orderDatabase,
  adminId,
  salesId,
  opsId,
  financeId,
} from "./order-backend.mjs";
const { db, request } = await orderDatabase();
let checks = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log("PASS", name);
  checks++;
}
const fresh = randomUUID();
const edit = (actor: string | null = adminId, active = true, role = "sales") =>
  request(
    "select public.edit_staff($1,'Sarah','Jones','07700900123',$2::public.staff_role,$3)",
    [fresh, role, active],
    actor,
  );
try {
  await test("new Auth users are provisioned inactive; metadata cannot grant administrator", async () => {
    await db.query(
      "insert into auth.users(id,email,raw_user_meta_data) values($1,'sarah@example.test',$2)",
      [
        fresh,
        JSON.stringify({
          role: "administrator",
          active: true,
          full_name: "Sarah Jones",
        }),
      ],
    );
    const [u] = await request(
      "select * from public.users where id=$1",
      [fresh],
      adminId,
    );
    assert.equal(u.active, false);
    assert.equal(u.role, "sales");
    assert.equal(
      (
        await request(
          "select * from public.staff_profiles where id=$1",
          [fresh],
          adminId,
        )
      )[0].email,
      "sarah@example.test",
    );
  });
  await test("sales, operations, finance, anonymous cannot administer or access another private profile", async () => {
    for (const actor of [salesId, opsId, financeId, null])
      await assert.rejects(() => edit(actor));
    assert.equal(
      (
        await request(
          "select * from public.staff_profiles where id=$1",
          [fresh],
          salesId,
        )
      ).length,
      0,
    );
  });
  await test("administrator assigns details and role; self-demotion and last-admin deactivation blocked", async () => {
    await edit();
    assert.equal(
      (
        await request(
          "select * from public.users where id=$1",
          [fresh],
          adminId,
        )
      )[0].active,
      true,
    );
    await assert.rejects(() =>
      request(
        "select public.edit_staff($1,'Admin','User','','sales',false)",
        [adminId],
        adminId,
      ),
    );
    await assert.rejects(() =>
      request(
        "select public.update_staff($1,'sales',false)",
        [adminId],
        adminId,
      ),
    );
  });
  await test("auth metadata sync records last login and password event without hashes or tokens", async () => {
    await db.query(
      "update auth.users set last_sign_in_at=now(),encrypted_password='SENSITIVE_TEST_HASH' where id=$1",
      [fresh],
    );
    const [p] = await request(
      "select * from public.staff_profiles where id=$1",
      [fresh],
      fresh,
    );
    assert.ok(p.last_login);
    const logs = await request(
      "select * from public.audit_logs where entity_id=$1",
      [fresh],
      adminId,
    );
    assert.ok(logs.some((l) => l.action === "LOGIN"));
    assert.ok(logs.some((l) => l.action === "PASSWORD_CHANGED"));
    assert.ok(!JSON.stringify(logs).includes("SENSITIVE_TEST_HASH"));
  });
  await test("password grants are user bound, expire and can be consumed once", async () => {
    await db.query(
      "insert into public.password_grants values('good',$1,now()+interval '15 minutes'),('expired',$1,now()-interval '1 minute')",
      [fresh],
    );
    assert.equal(
      (
        await request(
          "select public.consume_password_grant('good') ok",
          [],
          salesId,
        )
      )[0].ok,
      false,
    );
    assert.equal(
      (
        await request(
          "select public.consume_password_grant('expired') ok",
          [],
          fresh,
        )
      )[0].ok,
      false,
    );
    assert.equal(
      (
        await request(
          "select public.consume_password_grant('good') ok",
          [],
          fresh,
        )
      )[0].ok,
      true,
    );
    assert.equal(
      (
        await request(
          "select public.consume_password_grant('good') ok",
          [],
          fresh,
        )
      )[0].ok,
      false,
    );
    await assert.rejects(() =>
      request(
        "insert into public.password_grants values('forged',$1,now())",
        [fresh],
        fresh,
      ),
    );
  });
  await test("invitation/reset audit accepts administrator only and fixed event names", async () => {
    await request(
      "select public.staff_auth_event($1,'INVITATION_SENT')",
      [fresh],
      adminId,
    );
    await request(
      "select public.staff_auth_event($1,'PASSWORD_RESET_REQUESTED')",
      [fresh],
      adminId,
    );
    await assert.rejects(() =>
      request(
        "select public.staff_auth_event($1,'INVITATION_SENT')",
        [fresh],
        salesId,
      ),
    );
    await assert.rejects(() =>
      request(
        "select public.staff_auth_event($1,'secret arbitrary payload')",
        [fresh],
        adminId,
      ),
    );
  });
  await test("email throttle is server-only and denies immediate repeat", async () => {
    await assert.rejects(() =>
      request("select public.claim_auth_email('test')", [], salesId),
    );
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select public.claim_auth_email('test') ok",
        )
      ).rows[0].ok,
      true,
    );
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select public.claim_auth_email('test') ok",
        )
      ).rows[0].ok,
      false,
    );
  });
  const cid = randomUUID(),
    oid = randomUUID();
  await db.query(
    "insert into public.customers(id,first_name,last_name,assigned_to) values($1,'Historic','Customer',$2)",
    [cid, fresh],
  );
  await db.query(
    "insert into public.orders(id,customer_id,created_by) values($1,$2,$3)",
    [oid, cid, fresh],
  );
  await test("sales cannot read or edit another representative’s order or payment", async () => {
    assert.equal(
      (await request("select * from public.orders where id=$1", [oid], salesId))
        .length,
      0,
    );
    assert.equal(
      (await request("select * from public.orders where id=$1", [oid], fresh))
        .length,
      1,
    );
    await assert.rejects(() =>
      request("select public.save_order($1,'{}',1,false)", [oid], salesId),
    );
    await assert.rejects(() =>
      request(
        "select public.save_order_internal($1,'{}',1,false)",
        [oid],
        salesId,
      ),
    );
    assert.equal(
      (await request("select public.order_is_draft($1) ok", [oid], salesId))[0]
        .ok,
      false,
    );
  });
  await test("deactivation blocks existing sessions and grants while retaining historical records; reactivation restores access", async () => {
    await db.query(
      "insert into public.password_grants values('inactive',$1,now()+interval '15 minutes')",
      [fresh],
    );
    await edit(adminId, false);
    assert.equal(
      (
        await request(
          "select public.has_permission('orders.read') ok",
          [],
          fresh,
        )
      )[0].ok,
      false,
    );
    assert.equal(
      (await request("select * from public.orders", [], fresh)).length,
      0,
    );
    assert.equal(
      (
        await request(
          "select public.consume_password_grant('inactive') ok",
          [],
          fresh,
        )
      )[0].ok,
      false,
    );
    assert.equal(
      (
        await request("select * from public.orders where id=$1", [oid], adminId)
      )[0].created_by,
      fresh,
    );
    assert.equal(
      (
        await request(
          "select * from public.customers where id=$1",
          [cid],
          adminId,
        )
      )[0].assigned_to,
      fresh,
    );
    await edit();
    assert.equal(
      (await request("select * from public.orders where id=$1", [oid], fresh))
        .length,
      1,
    );
  });
  await test("direct writes to profiles and audit logs are blocked; changes audited", async () => {
    await assert.rejects(() =>
      request(
        "update public.staff_profiles set email='attacker@example.test' where id=$1",
        [fresh],
        fresh,
      ),
    );
    await assert.rejects(() =>
      request("delete from public.users where id=$1", [fresh], adminId),
    );
    const logs = await request(
      "select * from public.audit_logs where entity_id=$1",
      [fresh],
      adminId,
    );
    assert.ok(
      logs.some(
        (l) =>
          l.entity_type === "users" &&
          l.previous_value?.active === true &&
          l.new_value?.active === false,
      ),
    );
  });
  await test("order ownership cannot be bypassed through customer reassignment or related records", async () => {
    await assert.rejects(() =>
      request(
        "update public.customers set assigned_to=$2 where id=$1",
        [cid, salesId],
        salesId,
      ),
    );
    await db.query(
      "insert into public.tasks(customer_id,order_id,title,assigned_to,due_date,created_by) values($1,$2,'Private order task',$3,current_date,$3)",
      [cid, oid, fresh],
    );
    await db.query(
      "insert into public.activities(customer_id,order_id,type,description,user_id) values($1,$2,'Note','Private order note',$3)",
      [cid, oid, fresh],
    );
    assert.equal(
      (
        await request(
          "select * from public.tasks where order_id=$1",
          [oid],
          salesId,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await request(
          "select * from public.activities where order_id=$1",
          [oid],
          salesId,
        )
      ).length,
      0,
    );
    await assert.rejects(() =>
      request(
        "insert into public.activities(customer_id,order_id,type,description,user_id) values($1,$2,'Note','forged',$3)",
        [cid, oid, salesId],
        salesId,
      ),
    );
  });
  await test("sales summaries aggregate assignments and are administrator-only", async () => {
    await assert.rejects(() =>
      request("select public.staff_sales_summary()", [], salesId),
    );
    const [row] = await request(
      "select public.staff_sales_summary() result",
      [],
      adminId,
    );
    assert.equal(row.result[fresh].orders, 1);
  });
  console.log(`${checks} staff/auth database checks passed`);
} finally {
  await db.close();
}
