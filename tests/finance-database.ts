import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  orderDatabase,
  adminId,
  salesId,
  financeId,
  opsId,
} from "./order-backend.mjs";
import { emptyDraft, blankConfiguration } from "../src/lib/orders/model";
const { db, request } = await orderDatabase();
let checks = 0;
const cid = randomUUID(),
  id = randomUUID(),
  itemId = randomUUID();
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  console.log("PASS", name);
  checks++;
}
const op = (
  operation: string,
  payload: object,
  actor = adminId,
  key = randomUUID(),
  target = id,
) =>
  request(
    "select public.finance_operation($1,$2,$3::jsonb,$4) result",
    [target, operation, JSON.stringify(payload), key],
    actor,
  );
const order = async () =>
  (await request("select * from public.orders where id=$1", [id], adminId))[0];
const receipt = (amount: string, status = "Completed") => ({
  amount,
  method: "Bank Transfer",
  payment_date: "2026-09-28",
  reference: "Acceptance",
  notes: "Synthetic",
  status,
  confirm_overpayment: false,
});
try {
  await db.query(
    "insert into public.customers(id,first_name,last_name,assigned_to) values($1,'Finance','Acceptance',$2)",
    [cid, salesId],
  );
  const [product] = await request(
    "select * from public.products where name='EL'",
  );
  const draft = emptyDraft(cid);
  draft.measurements = {
    right_bd: 31,
    left_bd: 32,
    working_distance: 455,
    notes: "Touch picker test",
  };
  draft.items = [
    {
      id: itemId,
      product_id: product.id,
      quantity: 1,
      unit_price: 2000,
      discount_type: "none",
      discount_value: 0,
      discount_reason: "",
      vat_rate: 0,
      configuration: {
        ...blankConfiguration(),
        magnification: "4x",
        frame: "Sport",
        frame_colour: "Black",
        working_distance: 455,
      },
    },
  ];
  await test("working distance persists numerically in draft and rejects invalid values on both paths", async () => {
    await request("select public.save_order($1,$2::jsonb,0,false)", [
      id,
      JSON.stringify(draft),
    ]);
    assert.equal(
      (
        await request(
          "select working_distance from public.measurements where order_id=$1",
          [id],
        )
      )[0].working_distance,
      455,
    );
    assert.equal(
      (
        await request(
          "select jsonb_typeof(configuration->'working_distance') type from public.order_items where order_id=$1",
          [id],
        )
      )[0].type,
      "number",
    );
    for (const invalid of [349, 551, 450.5]) {
      await assert.rejects(() =>
        request("select public.save_order($1,$2::jsonb,1,false)", [
          id,
          JSON.stringify({
            ...draft,
            measurements: { ...draft.measurements, working_distance: invalid },
          }),
        ]),
      );
      await assert.rejects(() =>
        request("select public.save_order($1,$2::jsonb,1,false)", [
          id,
          JSON.stringify({
            ...draft,
            items: [
              {
                ...draft.items[0],
                configuration: {
                  ...draft.items[0].configuration,
                  working_distance: invalid,
                },
              },
            ],
          }),
        ]),
      );
    }
    await request("select public.save_order($1,$2::jsonb,1,true)", [
      id,
      JSON.stringify(draft),
    ]);
    assert.equal((await order()).total, 2000);
  });
  await test("£2,000 original price with authorised £200 discount becomes £1,800 at 0% VAT", async () => {
    await op("discount", {
      item_id: itemId,
      type: "fixed",
      value: "200",
      reason: "Authorised acceptance offer",
      vat_rate: "0",
      vat_applicable: true,
    });
    assert.equal((await order()).total, 1800);
    const [line] = await request(
      "select * from public.order_items where id=$1",
      [itemId],
    );
    assert.equal(line.unit_price, 2000);
    assert.equal(line.authorised_by, adminId);
    assert.ok(line.discounted_at);
  });
  await test("deposit rule blocks manufacturer submission before payment", async () => {
    await op("deposit", { type: "fixed", value: "500" });
    assert.equal((await order()).deposit_outstanding, 500);
    await assert.rejects(
      () =>
        request(
          "select public.operate_order($1,'status',$2::jsonb,$3)",
          [
            id,
            JSON.stringify({
              status: "Submitted to Manufacturer",
              expected_status: "Order Confirmed",
              reason: "Gate test",
            }),
            randomUUID(),
          ],
          adminId,
        ),
      /deposit/,
    );
  });
  const deposit = randomUUID(),
    final = randomUUID(),
    refund = randomUUID();
  await test("£500 deposit produces £1,300 balance and satisfies the requirement", async () => {
    await op("payment", receipt("500"), salesId, deposit);
    const o = await order();
    assert.equal(o.amount_paid, 500);
    assert.equal(o.balance, 1300);
    assert.equal(o.payment_status, "Deposit Paid");
    assert.equal(o.deposit_satisfied, true);
    await request(
      "select public.operate_order($1,'status',$2::jsonb,$3)",
      [
        id,
        JSON.stringify({
          status: "Submitted to Manufacturer",
          expected_status: "Order Confirmed",
          reason: "Deposit received",
        }),
        randomUUID(),
      ],
      adminId,
    );
  });
  await test("£1,300 final receipt produces zero balance and Paid; replay cannot duplicate", async () => {
    await op("payment", receipt("1300"), financeId, final);
    await op("payment", receipt("1300"), financeId, final);
    const o = await order();
    assert.equal(o.amount_paid, 1800);
    assert.equal(o.balance, 0);
    assert.equal(o.payment_status, "Paid");
  });
  await test("£200 partial refund remains linked to original payment and updates net received/balance", async () => {
    const payload = {
      payment_id: final,
      amount: "200",
      refund_date: "2026-09-28",
      reason: "Authorised partial refund",
      reference: "REF-1",
      notes: "",
    };
    await op("refund", payload, adminId, refund);
    await op("refund", payload, adminId, refund);
    const o = await order();
    assert.equal(o.refunds_total, 200);
    assert.equal(o.net_received, 1600);
    assert.equal(o.balance, 200);
    assert.equal(o.payment_status, "Partially Refunded");
    const [r] = await request(
      "select * from public.refunds where id=$1",
      [refund],
      adminId,
    );
    assert.equal(r.payment_id, final);
    assert.equal(
      (
        await request(
          "select status from public.payments where id=$1",
          [final],
          financeId,
        )
      )[0].status,
      "Partially Refunded",
    );
  });
  await test("completed records cannot be deleted, edited or manually marked unpaid", async () => {
    await assert.rejects(() =>
      request("delete from public.payments where id=$1", [deposit], adminId),
    );
    await assert.rejects(
      () => db.query("delete from public.payments where id=$1", [deposit]),
      /cannot be deleted/,
    );
    await assert.rejects(
      () =>
        db.query("update public.payments set amount=1 where id=$1", [deposit]),
      /immutable/,
    );
    await assert.rejects(() =>
      op("payment_status", { payment_id: deposit, status: "Failed" }),
    );
  });
  await test("over-refunds, fractional pennies, negative amounts and unauthorised actions rejected", async () => {
    await assert.rejects(() =>
      op("refund", {
        payment_id: final,
        amount: "1100.01",
        refund_date: "2026-09-28",
        reason: "Bad",
      }),
    );
    await assert.rejects(() =>
      op(
        "refund",
        {
          payment_id: final,
          amount: "1",
          refund_date: "2026-09-28",
          reason: "Bad",
        },
        salesId,
      ),
    );
    for (const amount of ["1.001", "-1", "0"])
      await assert.rejects(() => op("payment", receipt(amount)));
    await assert.rejects(() => op("payment", receipt("1"), opsId));
  });
  await test("pending/failed payments do not affect balance; pending completion recalculates once", async () => {
    const pending = randomUUID();
    await op("payment", receipt("50", "Pending"), financeId, pending);
    assert.equal((await order()).balance, 200);
    await op("payment", receipt("25", "Failed"), financeId);
    assert.equal((await order()).balance, 200);
    await op(
      "payment_status",
      { payment_id: pending, status: "Completed", confirm_overpayment: false },
      financeId,
    );
    assert.equal((await order()).balance, 150);
  });
  await test("overpayment needs privileged explicit consent and produces a visible credit balance", async () => {
    await assert.rejects(() => op("payment", receipt("151"), financeId));
    await assert.rejects(() =>
      op("payment", { ...receipt("151"), confirm_overpayment: true }, salesId),
    );
    await op(
      "payment",
      { ...receipt("151"), confirm_overpayment: true },
      financeId,
    );
    assert.equal((await order()).balance, -1);
  });
  await test("charges and per-line VAT use database decimal arithmetic", async () => {
    await op("charge", {
      category: "Prescription",
      description: "Prescription integration",
      amount: "19.99",
      vat_rate: "20",
      vat_applicable: true,
    });
    assert.equal((await order()).total, 1823.99);
    await op("charge", {
      category: "Other",
      description: "Other agreed charge",
      amount: "10",
      vat_rate: "20",
      vat_applicable: false,
    });
    assert.equal((await order()).total, 1833.99);
  });
  await test("finance application is audited and does not create a fictitious payment", async () => {
    const before = (await order()).amount_paid;
    await op("finance", {
      required: true,
      provider: "Test provider",
      amount_financed: "100",
      customer_deposit: "500",
      application_date: "2026-09-28",
      reference: "APP-1",
      status: "Approved",
      approval_date: "2026-09-28",
      notes: "Internal tracking",
    });
    assert.equal((await order()).amount_paid, before);
  });
  await test("customer totals, payment filters and RLS reflect only permitted records", async () => {
    const [r] = await request(
      "select public.customer_financial_summary($1) summary",
      [cid],
      financeId,
    );
    assert.equal(r.summary.refunds, 200);
    assert.equal(r.summary.lifetime_value, 1833.99);
    const [list] = await request(
      "select public.search_payments($1::jsonb) result",
      [JSON.stringify({ customer: cid, status: "Failed" })],
      financeId,
    );
    assert.equal(list.result.length, 1);
    await assert.rejects(() =>
      request("select public.search_payments('{}')", [], opsId),
    );
    assert.equal(
      (
        await request(
          "select public.order_financial_summary($1) result",
          [id],
          opsId,
        )
      )[0].result,
      null,
    );
  });
  await test("every financial operation appears in the restricted activity timeline and append-only audit", async () => {
    const events = await request(
      "select * from public.order_events where order_id=$1 and audience='finance'",
      [id],
      adminId,
    );
    assert.ok(events.some((e) => e.kind === "Finance: refund"));
    assert.ok(events.some((e) => e.kind === "Finance: discount"));
    const audits = await request(
      "select * from public.audit_logs where new_value->>'order_id'=$1",
      [id],
      adminId,
    );
    for (const entity of [
      "refunds",
      "order_charges",
      "order_finance",
      "payments",
      "finance_requests",
    ])
      assert.ok(audits.some((a) => a.entity_type === entity));
  });
  await test("system checks are administrator-only, inspect RLS and audit without exposing record values", async () => {
    for (const actor of [salesId, opsId, financeId, null])
      await assert.rejects(() =>
        request("select public.system_health()", [], actor),
      );
    const count = (
      await db.query<{ n: number }>("select count(*)::int n from public.orders")
    ).rows[0].n;
    const [health] = await request(
      "select public.system_health() result",
      [],
      adminId,
    );
    assert.ok(
      health.result.every((r: { status: string }) => r.status === "Healthy"),
    );
    assert.ok(!JSON.stringify(health).includes("APP-1"));
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from public.orders",
        )
      ).rows[0].n,
      count,
    );
    await db.exec("alter table public.refunds disable row level security");
    const [bad] = await request(
      "select public.system_health() result",
      [],
      adminId,
    );
    assert.equal(
      bad.result.find((r: { component: string }) => r.component === "refunds")
        .status,
      "Failed",
    );
    await db.exec("alter table public.refunds enable row level security");
  });
  console.log(`${checks} Phase 5 database checks passed`);
} finally {
  await db.close();
}
