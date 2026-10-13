import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  orderDatabase,
  adminId,
  salesId,
  financeId,
  opsId,
} from "./order-backend.mjs";
import { reportPdf } from "../src/lib/reports/pdf";
import type { Report } from "../src/lib/reports/model";
const { db, request } = await orderDatabase();
let count = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  console.log("PASS", name);
  count++;
}
async function rpc(name: string, args: unknown[] = [], actor = adminId) {
  return (
    await request(
      `select public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) value`,
      args,
      actor,
    )
  )[0]?.value;
}
const filters = { from: "2026-09-01", to: "2026-09-30", page: 0 };
const c = randomUUID(),
  other = randomUUID(),
  o = randomUUID(),
  o2 = randomUUID(),
  draft = randomUUID(),
  paid = randomUUID(),
  old = randomUUID();
let r: Report;
try {
  await db.query(
    "insert into public.customers(id,first_name,last_name,assigned_to,lead_source,created_at,status) values($1,'Synthetic','Reporting',$2,'Website','2026-09-10','Customer'),($3,'Other','Owner',$4,null,'2026-08-01','Lead')",
    [c, salesId, other, adminId],
  );
  for (const [id, customer, creator, date] of [
    [o, c, salesId, "2026-09-10"],
    [o2, other, adminId, "2026-09-11"],
    [old, c, salesId, "2026-08-01"],
  ])
    await db.query(
      "insert into public.orders(id,customer_id,created_by,status,confirmed_at,confirmed_by,created_at,order_date) values($1,$2,$3,'Order Confirmed',$4::timestamptz,$3,$4::timestamptz,$4::timestamptz::date)",
      [id, customer, creator, date],
    );
  await db.query(
    "insert into public.orders(id,customer_id,created_by,created_at) values($1,$2,$3,'2026-09-15')",
    [draft, c, salesId],
  );
  const products = await request("select * from public.products", [], adminId);
  const et = products.find((p) => p.sku === "LOUPE-ET")!,
    et2 = products.find((p) => p.sku === "LOUPE-ET2-3IN1")!,
    light = products.find((p) => p.sku === "LIGHT-WIRELESS")!;
  async function line(
    order: string,
    product: typeof et,
    price: number,
    discount: number,
  ) {
    await db.query(
      "insert into public.order_items(id,order_id,product_id,sku,description,kind,quantity,unit_price,discount_type,discount_value,discount_reason,vat_rate,subtotal,discount_amount,vat_amount,total) values($1,$2,$3,$4,$5,$6,1,$7,'fixed',$8,'Test discount',20,$7,$8,round(($7::numeric-$8)*.2,2),round(($7::numeric-$8)*1.2,2))",
      [
        randomUUID(),
        order,
        product.id,
        product.sku,
        product.name,
        product.kind,
        price,
        discount,
      ],
    );
  }
  await line(o, et2, 2000, 200);
  await line(o, light, 500, 0);
  await line(o2, et, 1000, 0);
  await line(old, et, 100, 0);
  for (const id of [o, o2, old])
    await db.query("select public.recalculate_finance($1)", [id]);
  await db.query(
    "insert into public.prescriptions(order_id,required,right_eye) values($1,true,$2)",
    [o, JSON.stringify({ sphere: -2 })],
  );
  await db.query(
    "insert into public.payments(id,order_id,amount,payment_date,method,received_by,created_by) values($1,$2,600,'2026-09-12','Card',$3,$3),($4,$5,120,'2026-09-12','Cash',$3,$3)",
    [paid, o, salesId, randomUUID(), old],
  );
  await db.query(
    "insert into public.refunds(id,order_id,payment_id,amount,refund_date,reason,authorised_by) values($1,$2,$3,60,'2026-09-20','Test',$4)",
    [randomUUID(), o, paid, adminId],
  );
  await db.query("select public.recalculate_finance($1)", [o]);
  await test("confirmed aliases seeded, unmapped model and original catalogue names retained", async () => {
    assert.equal(et.name, "ET 1");
    assert.equal(et.display_name, "ET1 / ELEVATE ERGO™");
    assert.equal(et2.display_name, "ET2 3-in-1 / ELEVATE ADAPT™");
    assert.equal(
      products.find((p) => p.name === "EL")!.elevate_product_name,
      "",
    );
    assert.ok(
      (
        await db.query(
          "select * from public.audit_logs where entity_id='202609300015'",
        )
      ).rows.length,
    );
  });
  await test("report totals reconcile orders, discounts and VAT without receipt/refund join inflation", async () => {
    r = await rpc("report_data", [JSON.stringify(filters)]);
    assert.equal(r.sales!.orders, 2);
    assert.equal(r.sales!.gross_order_value, 3500);
    assert.equal(r.sales!.discounts, 200);
    assert.equal(r.sales!.net_sales, 3300);
    assert.equal(r.sales!.vat, 660);
    assert.equal(r.sales!.total_order_value, 3960);
    assert.equal(r.cash!.payments_received, 720);
    assert.equal(r.cash!.refunds, 60);
    assert.equal(r.cash!.net_receipts, 660);
    assert.equal(r.sales!.outstanding, 3420);
    assert.equal(r.records_total, 3);
    assert.equal(r.cash_records_total, 3);
    assert.equal(
      r
        .cash_records!.filter((v) => v.kind === "Payment")
        .reduce((n, v) => n + Number(v.amount), 0),
      720,
    );
  });
  await test("product and wireless totals stay separate; prescription returns aggregate only", async () => {
    assert.equal(r.wireless!.quantity, 1);
    assert.equal(r.wireless!.revenue, 500);
    assert.equal(r.sales!.light_attached_orders, 1);
    assert.equal(r.sales!.loupe_orders, 2);
    assert.equal(r.sales!.prescription_orders, 1);
    assert.equal(r.sales!.non_prescription_orders, 1);
    assert.equal(
      r.products!.reduce((n, p) => n + Number(p.revenue), 0),
      3300,
    );
    assert.ok(!JSON.stringify(r).includes("sphere"));
    assert.equal(r.financial!.vat_collected, null);
  });
  await test("sales cannot access unrelated reports even with forged representative filters", async () => {
    const own = await rpc("report_data", [JSON.stringify(filters)], salesId);
    assert.equal(own.sales.orders, 1);
    assert.equal(own.sales.total_order_value, 2760);
    assert.ok(!own.records.some((x: { id: string }) => x.id === o2));
    const forged = await rpc(
      "report_data",
      [JSON.stringify({ ...filters, rep: adminId })],
      salesId,
    );
    assert.equal(forged.sales.orders, 0);
  });
  await test("finance gets financial aggregates without clinical data; operations only fulfilment", async () => {
    const finance = await rpc(
      "report_data",
      [JSON.stringify(filters)],
      financeId,
    );
    assert.equal(finance.sales.total_order_value, 3960);
    const ops = await rpc("report_data", [JSON.stringify(filters)], opsId);
    assert.equal(ops.sales, undefined);
    assert.equal(ops.cash, undefined);
    assert.equal(ops.products, undefined);
    assert.ok(
      ops.records.every(
        (x: Record<string, unknown>) =>
          !("balance" in x) && !("payment_status" in x),
      ),
    );
    assert.equal(ops.records_total, 2);
  });
  await test("date, product, model, source, representative and payment filters reconcile", async () => {
    for (const f of [
      { product: et2.id },
      { model: "ET2 3-in-1" },
      { lead_source: "Website" },
      { rep: salesId },
      { payment_status: "Partially Refunded" },
    ]) {
      const x = await rpc("report_data", [
        JSON.stringify({ ...filters, ...f }),
      ]);
      assert.equal(x.sales.orders, 1);
      assert.equal(x.sales.total_order_value, 2760);
    }
    const none = await rpc("report_data", [
      JSON.stringify({ ...filters, from: "2026-10-01", to: "2026-10-01" }),
    ]);
    assert.equal(none.sales.orders, 0);
    assert.equal(none.cash.payments_received, 0);
  });
  await test("customer and source attribution distinguishes new records and missing source", async () => {
    assert.equal(r.customers!.total, 2);
    assert.equal(r.customers!.new, 1);
    assert.ok(
      r.sources!.some((s) => s.source === "Unattributed" && s.orders === 1),
    );
    assert.equal(
      r.representatives!.reduce((n, p) => n + Number(p.sales_value), 0),
      3960,
    );
  });
  await test("lifecycle timing uses recorded transitions and exposes sample sizes", async () => {
    await db.query(
      "insert into public.order_status_history(order_id,to_status,created_at,user_id) values($1,'Submitted to Manufacturer','2026-09-12',$2),($1,'In Production','2026-09-13',$2),($1,'QC','2026-09-20',$2),($1,'Customer Delivery','2026-09-25',$2)",
      [o, adminId],
    );
    const x = await rpc("report_data", [JSON.stringify(filters)]);
    assert.equal(x.durations.order_to_manufacturer_days, 2);
    assert.equal(x.durations.manufacturing_to_qc_days, 7);
    assert.equal(x.durations.order_to_delivery_days, 15);
    assert.equal(x.durations.production_samples, 1);
  });
  await test("administrator product changes are audited and cannot rewrite saved order identities", async () => {
    const before = (
      await request(
        "select * from public.order_items where order_id=$1",
        [o],
        adminId,
      )
    )[0];
    const payload = {
      ...et2,
      manufacturer_name: "Easysee",
      manufacturer_model: "ET2 3-in-1",
      elevate_product_name: "ADAPT",
      elevate_product_family: "Ergonomic",
      display_name: "ET2 3-in-1 / ELEVATE ADAPT™",
      description: "Verified test",
      default_price: 2500,
      active: true,
      provisional: false,
    };
    await assert.rejects(
      () => rpc("save_product", [et2.id, JSON.stringify(payload)], salesId),
      /Access denied/,
    );
    await rpc("save_product", [et2.id, JSON.stringify(payload)]);
    const after = (
      await request(
        "select * from public.order_items where id=$1",
        [before.id],
        adminId,
      )
    )[0];
    assert.deepEqual(after, before);
    const model = (
      await request(
        "select * from public.products where id=$1",
        [et2.id],
        adminId,
      )
    )[0];
    assert.equal(model.name, "ET 2 3 In 1");
    assert.equal(model.default_price, 2500);
    assert.ok(
      (
        await request(
          "select * from public.audit_logs where entity_type='products' and entity_id=$1 and user_id=$2",
          [et2.id, adminId],
          adminId,
        )
      ).length,
    );
  });
  await test("manufacturer review retains factory model and excludes all finances after rebrand", async () => {
    const pack = await rpc("review_manufacturer", [o, [], "Test"]);
    assert.equal(pack.snapshot.items[0].manufacturer_model, "ET2 3-in-1");
    assert.equal(pack.snapshot.items[0].commercial_name, "ADAPT");
    assert.ok(!JSON.stringify(pack.snapshot).includes("unit_price"));
  });
  await test("exports are attributable and reject anonymous and inactive report access", async () => {
    await rpc("record_report_export", [JSON.stringify(filters), "csv"]);
    assert.ok(
      (
        await request(
          "select * from public.audit_logs where action='EXPORT' and entity_type='reports'",
          [],
          adminId,
        )
      ).length,
    );
    await assert.rejects(() =>
      request("select public.report_data($1)", [JSON.stringify(filters)], null),
    );
    await db.query("update public.users set active=false where id=$1", [
      salesId,
    ]);
    await assert.rejects(
      () => rpc("report_data", [JSON.stringify(filters)], salesId),
      /Access denied/,
    );
  });
  await test("report PDF renders a real-data aggregate summary", async () => {
    const bytes = await reportPdf(r, filters);
    assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), "%PDF-");
    await writeFile("output/pdf/phase7-management-report.pdf", bytes);
  });
  console.log(`${count} Phase 7 database/report checks passed.`);
} finally {
  await db.close();
}
