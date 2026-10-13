import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  orderDatabase,
  salesId,
  adminId,
  opsId,
  financeId,
} from "./order-backend.mjs";
import {
  emptyDraft,
  blankConfiguration,
  type Draft,
  type Order,
  type Product,
  type OrderFile,
} from "../src/lib/orders/model";
const { db, request } = await orderDatabase();
let checks = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log(`PASS ${name}`);
  checks++;
}
const customerId = randomUUID(),
  id = randomUUID();
let version = 0;
let file: OrderFile;
try {
  await db.query(
    "insert into public.customers(id,first_name,last_name,email) values($1,'Ada','Dentist','ada@example.test')",
    [customerId],
  );
  const products = (await request(
    "select * from public.products",
  )) as Product[];
  const el = products.find((p) => p.name === "EL")!,
    battery = products.find((p) => p.kind === "Battery")!;
  await test("updated database catalogue exposes supplied models, magnifications and colours", async () => {
    assert.deepEqual(el.options.magnification, ["3x", "4x", "5x", "6x"]);
    assert.deepEqual(
      products.find((p) => p.name === "ET 1")!.options.magnification,
      el.options.magnification,
    );
    assert.deepEqual(
      products.find((p) => p.name === "ET 2 3 In 1")!.options.magnification,
      ["Adjustable (3 In 1)"],
    );
    for (const p of products.filter((p) => p.kind === "Loupe"))
      assert.deepEqual(p.options.frame_colour, [
        "Silver",
        "Black",
        "Olive Gold",
        "Purple/Pink",
        "Blue",
      ]);
  });
  await test("all loupe models expose the supplied frame choices", async () => {
    for (const product of products.filter(p => p.kind === "Loupe"))
      assert.deepEqual(product.options.frame, ["Sport", "Circular frame", "Square frame"]);
  });
  const draft: Draft = emptyDraft(customerId);
  draft.measurements = {
    right_bd: 31.5,
    left_bd: 32,
    working_distance: 450,
    notes: "Seated position",
  };
  draft.current_step = 3;
  async function save(
    data = draft,
    confirm = false,
    expected = version,
    actor = salesId,
  ) {
    const rows = await request(
      "select public.save_order($1,$2::jsonb,$3,$4) result",
      [id, JSON.stringify(data), expected, confirm],
      actor,
    );
    const result = rows[0].result as { version: number; order_number: number };
    version = result.version;
    return result;
  }
  await test("create draft, reopen measurements and generated total BD", async () => {
    const result = await save();
    assert.equal(result.order_number, 1);
    const [m] = await request(
      "select * from public.measurements where order_id=$1",
      [id],
    );
    assert.equal(Number(m.total_bd), 63.5);
    const [o] = await request("select * from public.orders where id=$1", [id]);
    assert.equal(o.current_step, 3);
    assert.equal(o.customer_id, customerId);
  });
  await test("stale draft save rejected without overwriting persisted measurements", async () => {
    await assert.rejects(
      () =>
        save(
          { ...draft, measurements: { ...draft.measurements, notes: "stale" } },
          false,
          0,
        ),
      /another session/,
    );
    assert.equal(
      (
        await request(
          "select notes from public.measurements where order_id=$1",
          [id],
        )
      )[0].notes,
      "Seated position",
    );
  });
  await test("incomplete confirmation rolls back atomically", async () => {
    const before = version;
    await assert.rejects(() => save(draft, true), /one loupe/);
    assert.equal(
      (await request("select version from public.orders where id=$1", [id]))[0]
        .version,
      before,
    );
  });
  draft.prescription = {
    required: true,
    right_eye: { sphere: -1.25, cylinder: -0.5, axis: 90, add: 1, prism: 0 },
    left_eye: { sphere: -1, cylinder: -0.25, axis: 85, add: 1, prism: 0 },
    prescription_date: "2026-09-20",
    provider: "Example Optician",
    notes: "Prescription entered from original",
  };
  draft.items = [
    {
      id: randomUUID(),
      product_id: el.id,
      quantity: 1,
      unit_price: 2000,
      discount_type: "percent",
      discount_value: 10,
      discount_reason: "Show offer",
      vat_rate: 20,
      configuration: {
        magnification: "4x",
        frame: "Sport",
        frame_colour: "Black",
        working_distance: 450,
        manufacturer_instructions: "Check frame fit",
      },
    },
    {
      id: randomUUID(),
      product_id: battery.id,
      quantity: 2,
      unit_price: 100,
      discount_type: "fixed",
      discount_value: 20,
      discount_reason: "Bundle offer",
      vat_rate: 20,
      configuration: blankConfiguration(),
    },
  ];
  draft.payments = [
    {
      id: randomUUID(),
      amount: 500,
      payment_date: "2026-09-27",
      method: "Bank Transfer",
      reference: "DEP-001",
      notes: "Deposit",
    },
    {
      id: randomUUID(),
      amount: 100,
      payment_date: "2026-09-27",
      method: "Card",
      reference: "DEP-002",
      notes: "",
    },
  ];
  await test("persist prescription, configured products, discounts, VAT and multiple receipts", async () => {
    await save();
    const [o] = await request("select * from public.orders where id=$1", [id]);
    assert.equal(Number(o.subtotal), 2200);
    assert.equal(Number(o.discount_total), 220);
    assert.equal(Number(o.vat_total), 396);
    assert.equal(Number(o.total), 2376);
    assert.equal(Number(o.amount_paid), 600);
    assert.equal(Number(o.balance), 1776);
    assert.equal(
      (await request("select * from public.payments where order_id=$1", [id]))
        .length,
      2,
    );
  });
  await test("invalid catalogue options, negative/excess discounts and overpayment are rejected", async () => {
    for (const patch of [
      {
        configuration: {
          ...draft.items[0].configuration,
          frame: "Invalid frame",
        },
      },
      { discount_value: 101 },
      { discount_value: -2 },
    ])
      await assert.rejects(() =>
        save({
          ...draft,
          items: [{ ...draft.items[0], ...patch }, draft.items[1]],
        }),
      );
    await assert.rejects(
      () =>
        save({ ...draft, payments: [...draft.payments, { ...draft.payments[0], id: randomUUID(), amount: 9999 }] }),
      /exceed/,
    );
    assert.equal(
      Number(
        (await request("select total from public.orders where id=$1", [id]))[0]
          .total,
      ),
      2376,
    );
  });
  await test("required prescription cannot confirm without an attachment", async () => {
    await assert.rejects(
      () => save(draft, true),
      /Upload a prescription image or PDF/,
    );
    assert.equal(
      (await request("select status from public.orders where id=$1", [id]))[0]
        .status,
      "Draft",
    );
  });
  await test("upload association validates real private object and records audit", async () => {
    await assert.rejects(() =>
      request(
        "select public.register_order_file($1,$2,'rx.pdf','application/pdf',100,$3)",
        [id, `${id}/missing.pdf`, version],
      ),
    );
    await request(
      "insert into storage.objects(bucket_id,name,owner_id) values('order-prescriptions',$1,$2)",
      [`${id}/rx.pdf`, salesId],
    );
    file = (
      await request(
        "select public.register_order_file($1,$2,'rx.pdf','application/pdf',100,$3) result",
        [id, `${id}/rx.pdf`, version],
      )
    )[0].result as OrderFile;
    version++;
    assert.equal(file.order_id, id);
  });
  await test("attachment permits confirmation without typed prescription details", async () => {
    const attachmentOnly = structuredClone(draft);
    attachmentOnly.prescription = {
      ...emptyDraft(customerId).prescription,
      required: true,
    };
    await db.exec("begin; set local role authenticated;");
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
        salesId,
      ]);
      await db.query("select public.save_order($1,$2::jsonb,$3,true)", [
        id,
        JSON.stringify(attachmentOnly),
        version,
      ]);
      assert.equal(
        (await db.query<{ status: string }>("select status from public.orders where id=$1", [id]))
          .rows[0].status,
        "Order Confirmed",
      );
    } finally {
      await db.exec("rollback");
    }
  });
  await test("clinical RLS restricts finance and operations, and operations cannot read drafts", async () => {
    assert.equal(
      (await request("select * from public.orders", [], opsId)).length,
      0,
    );
    assert.equal(
      (await request("select * from public.orders", [], financeId)).length,
      1,
    );
    for (const actor of [opsId, financeId]) {
      assert.equal(
        (await request("select * from public.prescriptions", [], actor)).length,
        0,
      );
      assert.equal(
        (await request("select * from public.order_files", [], actor)).length,
        0,
      );
      assert.equal(
        (
          await request(
            "select * from storage.objects where bucket_id='order-prescriptions'",
            [],
            actor,
          )
        ).length,
        0,
      );
      await assert.rejects(
        () => save(draft, false, version, actor),
        /Access denied/,
      );
    }
  });
  await test("confirm atomically timestamps, attributes, audits and preserves all data", async () => {
    draft.current_step = 7;
    await save(draft, true);
    const [o] = (await request("select * from public.orders where id=$1", [
      id,
    ])) as Order[];
    assert.equal(o.status, "Order Confirmed");
    assert.equal(o.confirmed_by, salesId);
    assert.ok(o.confirmed_at);
    assert.equal(
      (
        await request("select * from public.order_files where order_id=$1", [
          id,
        ])
      ).length,
      1,
    );
    assert.equal(
      (
        await request("select * from public.prescriptions where order_id=$1", [
          id,
        ])
      )[0].right_eye.sphere,
      -1.25,
    );
    assert.equal(
      (
        await request(
          "select * from public.activities where order_id=$1 and type='Order confirmed'",
          [id],
        )
      ).length,
      1,
    );
    const audit = await request(
      "select * from public.audit_logs where entity_type='orders' and entity_id=$1 and new_value->>'status'='Order Confirmed' and previous_value->>'status' is distinct from 'Order Confirmed'",
      [id],
      adminId,
    );
    assert.equal(audit.length, 1);
  });
  await test("confirmation retries are idempotent; confirmed data and attachments are immutable", async () => {
    await save(draft, true, version - 1);
    assert.equal(
      (
        await request(
          "select * from public.activities where order_id=$1 and type='Order confirmed'",
          [id],
        )
      ).length,
      1,
    );
    await assert.rejects(() => save(), /cannot be edited/);
    await assert.rejects(() =>
      request("update public.orders set total=0 where id=$1", [id]),
    );
    await assert.rejects(
      () =>
        request("select public.remove_order_file($1,$2)", [file.id, version]),
      /cannot be removed/,
    );
    await assert.rejects(() =>
      request(
        "insert into storage.objects(bucket_id,name,owner_id) values('order-prescriptions',$1,$2)",
        [`${id}/late.pdf`, salesId],
      ),
    );
    assert.equal(
      (await request("select * from public.orders", [], opsId)).length,
      1,
    );
  });
  await test("multiple independent orders use unique order numbers without duplicating customer", async () => {
    const second = randomUUID();
    const [row] = await request(
      "select public.save_order($1,$2::jsonb,0,false) result",
      [second, JSON.stringify(emptyDraft(customerId))],
    );
    assert.notEqual(row.result.order_number, 1);
    assert.equal(
      (
        await request("select * from public.customers where id=$1", [
          customerId,
        ])
      ).length,
      1,
    );
    assert.equal(
      (
        await request("select * from public.orders where customer_id=$1", [
          customerId,
        ])
      ).length,
      2,
    );
  });
  await test("deactivated and anonymous sessions cannot use order RPC or read prescriptions", async () => {
    await db.query("update public.users set active=false where id=$1", [
      salesId,
    ]);
    assert.equal((await request("select * from public.orders")).length, 0);
    assert.equal(
      (await request("select * from public.prescriptions")).length,
      0,
    );
    await assert.rejects(() => save(), /Access denied/);
    await assert.rejects(() =>
      request(
        "select public.save_order($1,$2::jsonb,0,false)",
        [randomUUID(), JSON.stringify(draft)],
        "",
      ),
    );
  });
  console.log(`\n${checks} order database checks passed.`);
} finally {
  await db.close();
}
