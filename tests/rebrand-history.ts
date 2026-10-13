import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { orderDatabase, adminId, salesId } from "./order-backend.mjs";
const { db, request } = await orderDatabase({ phase7: false });
try {
  const c = randomUUID(),
    o = randomUUID(),
    line = randomUUID(),
    invoice = randomUUID(),
    pack = randomUUID();
  await db.query(
    "insert into public.customers(id,first_name,last_name,assigned_to) values($1,'Historical','TEST',$2)",
    [c, salesId],
  );
  await db.query(
    "insert into public.orders(id,customer_id,created_by,status,confirmed_at,confirmed_by,total) values($1,$2,$3,'Order Confirmed',now(),$3,2400)",
    [o, c, salesId],
  );
  const [p] = await request(
    "select * from public.products where sku='LOUPE-ET'",
    [],
    adminId,
  );
  await db.query(
    "insert into public.order_items(id,order_id,product_id,sku,description,kind,quantity,unit_price,discount_type,discount_value,vat_rate,subtotal,discount_amount,vat_amount,total) values($1,$2,$3,'LOUPE-ET','ET 1','Loupe',1,2000,'none',0,20,2000,0,400,2400)",
    [line, o, p.id],
  );
  await db.query(
    "insert into public.invoices(id,invoice_number,order_id,customer_id,invoice_date,supply_date,status,currency,subtotal_net,discount_total,vat_total,gross_total,amount_paid,amount_due,snapshot,created_by) values($1,'HISTORICAL-TEST',$2,$3,current_date,current_date,'Draft','GBP',2000,0,400,2400,0,2400,$4,$5)",
    [
      invoice,
      o,
      c,
      JSON.stringify({
        company: { legal_name: "Manareta Ltd", trading_name: "Easysee UK" },
        lines: [{ description: "ET 1", total: 2400 }],
      }),
      adminId,
    ],
  );
  await db.query(
    "insert into public.manufacturer_packs(id,order_id,prepared_by,snapshot,version) values($1,$2,$3,$4,1)",
    [
      pack,
      o,
      adminId,
      JSON.stringify({ items: [{ description: "ET 1", sku: "LOUPE-ET" }] }),
    ],
  );
  const before = {
    customer: (
      await db.query("select * from public.customers where id=$1", [c])
    ).rows[0],
    order: (await db.query("select * from public.orders where id=$1", [o]))
      .rows[0],
    item: (
      await db.query("select * from public.order_items where id=$1", [line])
    ).rows[0],
    invoice: (
      await db.query("select * from public.invoices where id=$1", [invoice])
    ).rows[0],
    pack: (
      await db.query("select * from public.manufacturer_packs where id=$1", [
        pack,
      ])
    ).rows[0],
    audit: (
      await db.query<{ id: string }>(
        "select * from public.audit_logs order by id",
      )
    ).rows,
  };
  for (const file of [
    "202609300015_elevate_products.sql",
    "202609300016_reporting.sql",
  ])
    await db.exec(await readFile("supabase/migrations/" + file, "utf8"));
  for (const [table, key, id] of [
    ["customers", "customer", c],
    ["orders", "order", o],
    ["invoices", "invoice", invoice],
    ["manufacturer_packs", "pack", pack],
  ] as const)
    assert.deepEqual(
      (await db.query("select * from public." + table + " where id=$1", [id]))
        .rows[0],
      before[key],
    );
  const after = (
    await db.query<Record<string, unknown>>(
      "select * from public.order_items where id=$1",
      [line],
    )
  ).rows[0];
  delete after.product_identity;
  assert.deepEqual(after, before.item);
  const audit = (
    await db.query<{ id: string }>("select * from public.audit_logs")
  ).rows;
  for (const row of before.audit) assert.ok(audit.some((a) => a.id === row.id));
  console.log(
    "PASS migration preserves historical customer, order finances, item description, invoice snapshot, manufacturer snapshot and audit entries (6 checks)",
  );
} finally {
  await db.close();
}
