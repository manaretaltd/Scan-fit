import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  orderDatabase,
  salesId,
  financeId,
  opsId,
  adminId,
} from "./order-backend.mjs";
import { emptyDraft, blankConfiguration } from "../src/lib/orders/model";
const { db, request } = await orderDatabase();
let checks = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  console.log("PASS", name);
  checks++;
}
const id = randomUUID(),
  cid = randomUUID();
const op = (
  operation: string,
  payload: object,
  actor = salesId,
  key: string = randomUUID(),
) =>
  request(
    "select public.operate_order($1,$2,$3::jsonb,$4) result",
    [id, operation, JSON.stringify(payload), key],
    actor,
  );
try {
  await db.query(
    "insert into public.customers(id,first_name,last_name,practice_name,assigned_to) values($1,'Hub','Acceptance','Example practice',$2)",
    [cid, salesId],
  );
  const [el] = await request("select * from public.products where name='EL'");
  const draft = emptyDraft(cid);
  draft.measurements = {
    right_bd: 31,
    left_bd: 32,
    working_distance: 450,
    notes: "Seated",
  };
  draft.items = [
    {
      id: randomUUID(),
      product_id: el.id,
      configuration: {
        ...blankConfiguration(),
        magnification: "4x",
        frame: "Sport",
        frame_colour: "Blue",
        working_distance: 450,
        manufacturer_instructions: "Check fit",
      },
      quantity: 1,
      unit_price: 1000,
      discount_type: "none",
      discount_value: 0,
      discount_reason: "",
      vat_rate: 20,
    },
  ];
  await request("select public.save_order($1,$2::jsonb,0,true)", [
    id,
    JSON.stringify(draft),
  ]);
  await test("confirmation seeds lifecycle history and chronological activity", async () => {
    assert.equal(
      (
        await request(
          "select * from public.order_status_history where order_id=$1",
          [id],
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await request("select * from public.order_events where order_id=$1", [
          id,
        ])
      ).length,
      2,
    );
  });
  await test("finance adds payment atomically, retry does not duplicate, overpayment denied", async () => {
    const key = randomUUID(),
      payload = {
        amount: 200,
        payment_date: "2026-09-28",
        method: "Bank Transfer",
        reference: "TEST",
        notes: "",
      };
    await op("payment", payload, financeId, key);
    await op("payment", payload, financeId, key);
    const [o] = await request("select * from public.orders where id=$1", [id]);
    assert.equal(o.amount_paid, 200);
    assert.equal(o.balance, 1000);
    assert.equal(
      (await request("select * from public.payments where order_id=$1", [id]))
        .length,
      1,
    );
    await assert.rejects(
      () => op("payment", { ...payload, amount: 1001 }, financeId),
      /balance/,
    );
    await assert.rejects(() => op("payment", payload, opsId), /Access denied/);
  });
  await test("notes and assigned follow-ups update timeline and completed state", async () => {
    await op("note", { note: "Customer called" });
    const key = randomUUID();
    await op(
      "followup",
      {
        title: "Confirm delivery",
        description: "Call customer",
        assigned_to: opsId,
        due_date: "2026-10-03",
        priority: "High",
      },
      opsId,
      key,
    );
    await op("complete", { task_id: key, completed: true }, opsId);
    assert.equal(
      (await request("select * from public.tasks where id=$1", [key], opsId))[0]
        .completed,
      true,
    );
    assert.equal(
      (
        await request(
          "select * from public.order_events where order_id=$1 and kind='Follow-up'",
          [id],
        )
      ).length,
      2,
    );
  });
  await test("status and shipping events record responsible actor and reject stale changes", async () => {
    await op(
      "status",
      {
        status: "Ready for Manufacturer",
        expected_status: "Order Confirmed",
        reason: "Checked configuration",
      },
      opsId,
    );
    await assert.rejects(
      () =>
        op(
          "status",
          {
            status: "In Production",
            expected_status: "Order Confirmed",
            reason: "Stale",
          },
          opsId,
        ),
      /another session/,
    );
    await op(
      "status",
      {
        status: "Shipped to UK",
        expected_status: "Ready for Manufacturer",
        reason: "Courier reference TEST123",
      },
      opsId,
    );
    assert.equal(
      (
        await request(
          "select * from public.order_status_history where order_id=$1",
          [id],
        )
      ).length,
      3,
    );
    assert.equal(
      (await request("select * from public.orders where id=$1", [id], opsId))[0]
        .status,
      "Shipped to UK",
    );
    await assert.rejects(
      () =>
        request("select public.save_order($1,$2::jsonb,2,false)", [
          id,
          JSON.stringify(draft),
        ]),
      /cannot be edited/,
    );
  });
  await test("reference, measurement attribution and aftercare persist with audit records", async () => {
    await op(
      "details",
      {
        manufacturer_reference: "M-123",
      },
      opsId,
    );
    await op("measurement", {
      measurement_date: "2026-09-28",
      measured_by: salesId,
    });
    await op(
      "aftercare",
      {
        delivery_confirmed: true,
        fitting_date: "2026-10-22",
        fitting_completed: true,
        fit_satisfactory: "false",
        adjustment_required: true,
        adjustment_notes: "Adjust frame",
        return_to_manufacturer: true,
        warranty_case: true,
        warranty_status: "Open",
        resolution_date: "",
      },
      opsId,
    );
    assert.equal(
      (
        await request(
          "select * from public.order_aftercare where order_id=$1",
          [id],
          opsId,
        )
      )[0].adjustment_required,
      true,
    );
    const audits = await request(
      "select * from public.audit_logs where entity_id=$1",
      [id],
      adminId,
    );
    assert.ok(audits.some((a) => a.entity_type === "order_aftercare"));
  });
  const measurementFile = randomUUID(),
    financeFile = randomUUID();
  async function file(fileId: string, category: string, actor = salesId) {
    const path = `${id}/${fileId}.png`;
    await request(
      "insert into storage.objects(bucket_id,name,owner_id) values('order-attachments',$1,$2)",
      [path, actor],
      actor,
    );
    await op(
      "file",
      {
        category,
        path,
        filename: category + ".png",
        mime_type: "image/png",
        size_bytes: 123,
      },
      actor,
      fileId,
    );
    return path;
  }
  await test("category storage policies protect clinical and finance attachments", async () => {
    const clinicalPath = await file(measurementFile, "Measurements");
    await file(financeFile, "Finance", financeId);
    assert.equal(
      (
        await request(
          "select * from public.order_files where id=$1",
          [measurementFile],
          financeId,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await request(
          "select * from storage.objects where name=$1",
          [clinicalPath],
          opsId,
        )
      ).length,
      0,
    );
    await assert.rejects(
      () =>
        op(
          "file",
          {
            category: "Prescription",
            path: clinicalPath,
            filename: "x.png",
            mime_type: "image/png",
            size_bytes: 123,
          },
          opsId,
        ),
      /Access denied/,
    );
  });
  await test("manufacturer pack excludes financial fields and forbids finance documents", async () => {
    const key = randomUUID();
    await request("select public.edit_media($1,$2::jsonb)",[measurementFile,JSON.stringify({visibility:'Shareable'})],salesId);
    const [{ review }] = await request("select public.review_manufacturer($1,$2::uuid[],$3) review",[id,[measurementFile],"Please produce"],salesId);
    await request("select public.reserve_manufacturer($1,$2,$3::uuid[],$4,$5)",[id,key,[measurementFile],"Please produce",review.fingerprint],salesId);
    const [pack] = await request(
      "select * from public.manufacturer_packs where id=$1",
      [key],
    );
    const raw = JSON.stringify(pack.snapshot);
    for (const field of [
      "unit_price",
      "discount",
      "vat",
      "amount_paid",
      "balance",
      "payments",
      'total"',
    ])
      assert.ok(!raw.includes(field), field);
    assert.equal(pack.snapshot.items[0].configuration.frame, "Sport");
    await assert.rejects(
      () => op("manufacturer", { instructions: "", file_ids: [financeFile] }),
      /reviewed/,
    );
    await assert.rejects(
      () => op("manufacturer", { instructions: "", file_ids: [] }, opsId),
      /reviewed/,
    );
  });
  await test("role-filtered timeline hides financial/clinical events and audit is immutable", async () => {
    const events = await request(
      "select * from public.order_events where order_id=$1",
      [id],
      opsId,
    );
    assert.ok(events.every((e) => e.audience === "operational"));
    await assert.rejects(() =>
      request(
        "update public.order_events set description='tampered' where order_id=$1",
        [id],
      ),
    );
    await assert.rejects(() =>
      request("delete from public.audit_logs where entity_id=$1", [id]),
    );
  });
  await test("every operational mutation has an append-only audit entry", async () => {
    const audits = await request(
      "select entity_type from public.audit_logs where entity_id=$1 or new_value->>'order_id'=$1",
      [id],
      adminId,
    );
    for (const table of [
      "orders",
      "payments",
      "tasks",
      "order_files",
      "order_events",
      "order_status_history",
      "order_aftercare",
      "manufacturer_packs",
      "measurements",
    ])
      assert.ok(
        audits.some((a) => a.entity_type === table),
        table,
      );
  });
  await test("deactivated and anonymous callers cannot operate confirmed orders", async () => {
    await db.query("update public.users set active=false where id=$1", [
      salesId,
    ]);
    await assert.rejects(
      () => op("note", { note: "Denied" }),
      /confirmed order/,
    );
    await assert.rejects(() =>
      request(
        "select public.operate_order($1,$2,$3::jsonb,$4)",
        [id, "note", '{"note":"Denied"}', randomUUID()],
        "",
      ),
    );
  });
  console.log(`\n${checks} order hub database checks passed.`);
} finally {
  await db.close();
}
