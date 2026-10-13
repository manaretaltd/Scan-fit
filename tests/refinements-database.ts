import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { orderDatabase, adminId, salesId, opsId } from "./order-backend.mjs";
import { emptyDraft, blankConfiguration } from "../src/lib/orders/model";
import { invoicePdf } from "../src/lib/invoices/pdf";
import type { Invoice } from "../src/lib/invoices/types";
const { db, request } = await orderDatabase();
let count = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  console.log("PASS", name);
  count++;
}
const customer = randomUUID(),
  order = randomUUID();
const company = {
  legal_name: "Manareta Ltd",
  trading_name: "Easysee UK",
  address: "TEST ONLY - 1 Example Street\nLondon\nTEST 1AA",
  company_number: "TEST1234",
  registration_country: "England and Wales (TEST)",
  vat_registered: false,
  vat_number: "",
  email: "billing@example.test",
  telephone: "07700 900123",
  website: "https://example.test",
  currency: "GBP",
  invoice_prefix: "MAN-INV",
  default_vat_rate: "0",
  default_vat_applicable: false,
  payment_details: "TEST ONLY - do not send payment",
  payment_terms: "Payment within 14 days",
  footer: "Synthetic invoice for acceptance testing. Not a real tax document.",
  logo_path: "",
};
const op = async (operation: string, payload: object) =>
  request(
    "select public.finance_operation($1,$2,$3::jsonb,$4)",
    [order, operation, JSON.stringify(payload), randomUUID()],
    adminId,
  );
try {
  await db.query(
    "insert into public.customers(id,first_name,last_name,practice_name,assigned_to) values($1,'Test','Dentist','Synthetic Dental Practice',$2)",
    [customer, salesId],
  );
  await test("same-address flag stores one billing address and preserves separate addresses when unticked", async () => {
    const payload = {
      first_name: "Test",
      last_name: "Dentist",
      practice_name: "Synthetic Dental Practice",
      assigned_to: salesId,
      status: "Customer",
      preferred_contact: "Email",
      delivery_address_same_as_customer: true,
    };
    const addresses = [
      {
        kind: "Practice",
        line1: "10 Test Road",
        city: "London",
        county: "Test County",
        postcode: "TEST 2BB",
        country: "United Kingdom",
      },
      {
        kind: "Delivery",
        line1: "Ignored duplicate",
        country: "United Kingdom",
      },
    ];
    await request(
      "select public.save_customer($1::jsonb,$2::jsonb,$3,true)",
      [JSON.stringify(payload), JSON.stringify(addresses), customer],
      adminId,
    );
    assert.equal(
      (
        await request(
          "select * from public.customer_addresses where customer_id=$1",
          [customer],
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await request(
          "select county from public.customer_addresses where customer_id=$1",
          [customer],
        )
      )[0].county,
      "Test County",
    );
    await request(
      "select public.save_customer($1::jsonb,$2::jsonb,$3,true)",
      [
        JSON.stringify({
          ...payload,
          delivery_address_same_as_customer: false,
        }),
        JSON.stringify(addresses),
        customer,
      ],
      adminId,
    );
    assert.equal(
      (
        await request(
          "select * from public.customer_addresses where customer_id=$1",
          [customer],
        )
      ).length,
      2,
    );
  });
  const products = await request(
    "select * from public.products where sku in ('LOUPE-EL','LIGHT-WIRELESS')",
  );
  const draft = emptyDraft(customer);
  draft.measurements = {
    right_bd: 31,
    left_bd: 32,
    working_distance: 450,
    notes: "",
  };
  draft.items = products.map((p) => ({
    id: randomUUID(),
    product_id: p.id,
    quantity: 1,
    unit_price: p.kind === "Loupe" ? 2000 : 500,
    discount_type: "none" as const,
    discount_value: 0,
    discount_reason: "",
    vat_rate: 0,
    configuration:
      p.kind === "Loupe"
        ? {
            ...blankConfiguration(),
            magnification: "4x",
            frame: "Sport",
            frame_colour: "Black",
            working_distance: 450,
          }
        : blankConfiguration(),
  }));
  await request(
    "select public.save_order($1,$2::jsonb,0,false)",
    [order, JSON.stringify(draft)],
    salesId,
  );
  await db.query(
    "update public.orders set order_date='2026-10-01' where id=$1",
    [order],
  );
  await request(
    "select public.save_order($1,$2::jsonb,1,true)",
    [order, JSON.stringify(draft)],
    salesId,
  );
  await test("loupe £2000 and wireless light £500 remain separate and sum to £2500", async () => {
    assert.equal(
      (await request("select total from public.orders where id=$1", [order]))[0]
        .total,
      2500,
    );
    const f = (
      await request("select public.order_financial_summary($1) value", [order])
    )[0].value;
    assert.equal(f.product_value, 2000);
    assert.equal(f.lights, 500);
    assert.equal(f.accessories, 0);
  });
  await test("1 October confirmation produces 12–26 November window; authorised override audited", async () => {
    const o = (
      await request("select * from public.orders where id=$1", [order])
    )[0];
    assert.equal(o.manufacturing_expected_from, "2026-11-12");
    assert.equal(o.manufacturing_expected_to, "2026-11-26");
    assert.equal(o.expected_completion_date, "2026-11-26");
    await assert.rejects(
      () =>
        request(
          "select public.set_manufacturing_window($1,'2026-11-15','2026-11-30','Supplier agreed')",
          [order],
          salesId,
        ),
      /Access denied/,
    );
    await request(
      "select public.set_manufacturing_window($1,'2026-11-15','2026-11-30','Supplier agreed')",
      [order],
      opsId,
    );
    assert.equal(
      (
        await request(
          "select expected_completion_date from public.orders where id=$1",
          [order],
        )
      )[0].expected_completion_date,
      "2026-11-30",
    );
    await request(
      "select public.set_manufacturing_window($1,'2026-11-15','2026-11-30','Correct order date','2026-10-02')",
      [order],
      adminId,
    );
    assert.equal(
      (
        await request(
          "select manufacturing_expected_to from public.orders where id=$1",
          [order],
        )
      )[0].manufacturing_expected_to,
      "2026-11-27",
    );
  });
  const preview = async () =>
    (
      await request(
        "select public.invoice_preview($1,'2026-10-01','2026-10-15','TEST ONLY') value",
        [order],
        adminId,
      )
    )[0].value;
  await test("unverified/incomplete company details cannot issue and sales cannot manage settings", async () => {
    await assert.rejects(
      () =>
        request(
          "select public.reserve_invoice($1,'2026-10-01','2026-10-15','TEST ONLY','x')",
          [order],
          adminId,
        ),
      /settings are incomplete/,
    );
    await assert.rejects(
      () =>
        request(
          "select public.save_company_settings($1::jsonb,true)",
          [JSON.stringify(company)],
          salesId,
        ),
      /Access denied/,
    );
    await request(
      "select public.save_company_settings($1::jsonb,true)",
      [JSON.stringify(company)],
      adminId,
    );
  });
  let invoiceId = "";
  await test("invoice review detects concurrent edits and sequential issuance retries reuse the same number", async () => {
    const first = await preview();
    await op("deposit", { type: "fixed", value: "500" });
    await assert.rejects(
      () =>
        request(
          "select public.reserve_invoice($1,'2026-10-01','2026-10-15','TEST ONLY',$2)",
          [order, first.fingerprint],
          adminId,
        ),
      /changed/,
    );
    const current = await preview();
    invoiceId = (
      await request(
        "select public.reserve_invoice($1,'2026-10-01','2026-10-15','TEST ONLY',$2) id",
        [order, current.fingerprint],
        adminId,
      )
    )[0].id;
    const again = (
      await request(
        "select public.reserve_invoice($1,'2026-10-01','2026-10-15','TEST ONLY',$2) id",
        [order, current.fingerprint],
        adminId,
      )
    )[0].id;
    assert.equal(again, invoiceId);
  });
  await test("server PDF uses frozen supplier/customer/line snapshot; private finalisation links records", async () => {
    const invoice = (
      await request(
        "select * from public.invoices where id=$1",
        [invoiceId],
        adminId,
      )
    )[0] as Invoice;
    assert.match(invoice.invoice_number, /MAN-INV-\d{4}-0001/);
    assert.equal(invoice.snapshot.company.legal_name, "Manareta Ltd");
    assert.equal(invoice.snapshot.lines.length, 2);
    assert.equal(invoice.gross_total, 2500);
    const bytes = await invoicePdf(invoice);
    await mkdir("output/pdf", { recursive: true });
    await writeFile("output/pdf/phase51-test-invoice.pdf", bytes);
    assert.ok(bytes.length > 1500);
    const path = `${invoiceId}/invoice.pdf`;
    await db.query(
      "insert into storage.objects(bucket_id,name) values('invoices',$1)",
      [path],
    );
    await assert.rejects(
      () =>
        request(
          "select public.finalize_invoice($1,$2,$3,$4)",
          [invoiceId, adminId, path, "a".repeat(64)],
          adminId,
        ),
      /permission denied/,
    );
    await db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      await tx.query("select public.finalize_invoice($1,$2,$3,$4)", [
        invoiceId,
        adminId,
        path,
        "a".repeat(64),
      ]);
    });
    const saved = (
      await request(
        "select * from public.invoices where id=$1",
        [invoiceId],
        adminId,
      )
    )[0];
    assert.equal(saved.status, "Issued");
    assert.equal(saved.pdf_storage_path, path);
    const [media] = await request("select * from public.media_files where invoice_id=$1",[invoiceId],adminId);
    assert.equal(media.storage_path,path);assert.equal(media.storage_bucket,'invoices');assert.equal(media.category,'Invoice');
    for(const filter of [{customer},{order}]) {
      const [{result}] = await request("select public.search_media($1::jsonb) result",[JSON.stringify(filter)],adminId);
      assert.ok(result.items.some((f:{id:string})=>f.id===invoiceId));
    }
    assert.equal((await db.query("select * from storage.objects where bucket_id='invoices' and name=$1",[path])).rows.length,1);
  });
  await test("payments link without duplication, settle invoices, and leave original PDF/snapshot immutable", async () => {
    await op("payment", {
      amount: "2500",
      method: "Bank Transfer",
      payment_date: "2026-10-01",
      reference: "TEST",
      notes: "",
      status: "Completed",
      confirm_overpayment: false,
    });
    const payment = (
      await request(
        "select * from public.payments where order_id=$1",
        [order],
        adminId,
      )
    )[0];
    assert.equal(payment.invoice_id, invoiceId);
    let inv = (
      await request(
        "select * from public.invoices where id=$1",
        [invoiceId],
        adminId,
      )
    )[0];
    assert.equal(inv.status, "Paid");
    assert.equal(inv.amount_due, 0);
    assert.equal(inv.snapshot.balance, "2500.00");
    await op("refund", {
      payment_id: payment.id,
      amount: "200",
      refund_date: "2026-10-02",
      reason: "TEST",
      reference: "",
      notes: "",
    });
    inv = (
      await request(
        "select * from public.invoices where id=$1",
        [invoiceId],
        adminId,
      )
    )[0];
    assert.equal(inv.amount_due, 200);
    assert.equal(inv.status, "Partially Paid");
    await assert.rejects(
      () =>
        op("charge", {
          category: "Other",
          description: "Changed price",
          amount: "5",
          vat_applicable: false,
          vat_rate: "0",
        }),
      /locked/,
    );
    await assert.rejects(
      () =>
        request(
          "update public.invoices set gross_total=1 where id=$1",
          [invoiceId],
          adminId,
        ),
      /permission denied/,
    );
  });
  await test("invoice records and storage enforce role and order RLS; audit remains attributable", async () => {
    assert.equal(
      (await request("select * from public.invoices", [], opsId)).length,
      0,
    );
    assert.equal(
      (
        await request(
          "select * from storage.objects where bucket_id='invoices'",
          [],
          opsId,
        )
      ).length,
      0,
    );
    await db.query("update public.customers set assigned_to=$1 where id=$2", [
      adminId,
      customer,
    ]);
    await db.query("update public.orders set created_by=$1 where id=$2", [
      adminId,
      order,
    ]);
    assert.equal(
      (await request("select * from public.invoices", [], salesId)).length,
      0,
    );
    const logs = await request(
      "select * from public.audit_logs where entity_id=$1 and action='INVOICE_ISSUED'",
      [invoiceId],
      adminId,
    );
    assert.equal(logs[0].user_id, adminId);
  });
  await test("cancelled drafts preserve their number; replacement reservations advance sequence and validate VAT", async () => {
    const nextOrder = randomUUID();
    await request(
      "select public.save_order($1,$2::jsonb,0,true)",
      [
        nextOrder,
        JSON.stringify({
          ...draft,
          items: draft.items.map((item) => ({ ...item, id: randomUUID() })),
        }),
      ],
      adminId,
    );
    const pv = async () =>
      (
        await request(
          "select public.invoice_preview($1,'2026-10-01',null,'') value",
          [nextOrder],
          adminId,
        )
      )[0].value;
    let data = await pv();
    const reserve = async (fingerprint: string) =>
      (
        await request(
          "select public.reserve_invoice($1,'2026-10-01',null,'',$2) id",
          [nextOrder, fingerprint],
          adminId,
        )
      )[0].id;
    const id = await reserve(data.fingerprint);
    assert.match(
      (
        await request(
          "select invoice_number from public.invoices where id=$1",
          [id],
          adminId,
        )
      )[0].invoice_number,
      /-0002$/,
    );
    await assert.rejects(
      () => request("select public.cancel_invoice_draft($1,'')", [id], adminId),
      /reason/i,
    );
    await request(
      "select public.cancel_invoice_draft($1,'TEST replacement')",
      [id],
      adminId,
    );
    data = await pv();
    const nextId = await reserve(data.fingerprint);
    assert.notEqual(nextId, id);
    assert.match(
      (
        await request(
          "select invoice_number from public.invoices where id=$1",
          [nextId],
          adminId,
        )
      )[0].invoice_number,
      /-0003$/,
    );
    await request(
      "select public.cancel_invoice_draft($1,'TEST VAT')",
      [nextId],
      adminId,
    );
    await request(
      "select public.finance_operation($1,$2,$3::jsonb,$4)",
      [
        nextOrder,
        "charge",
        JSON.stringify({
          category: "Other",
          description: "VAT test",
          amount: "100",
          vat_applicable: true,
          vat_rate: "20",
        }),
        randomUUID(),
      ],
      adminId,
    );
    data = await pv();
    await assert.rejects(() => reserve(data.fingerprint), /not VAT registered/);
    await assert.rejects(
      () =>
        request(
          "select public.save_company_settings($1::jsonb,true)",
          [
            JSON.stringify({
              ...company,
              vat_registered: true,
              vat_number: "",
            }),
          ],
          adminId,
        ),
      /incomplete/,
    );
    await request(
      "select public.save_company_settings($1::jsonb,true)",
      [
        JSON.stringify({
          ...company,
          vat_registered: true,
          vat_number: "GB123456789",
        }),
      ],
      adminId,
    );
    data = await pv();
    const vatId = await reserve(data.fingerprint);
    const vi = (
      await request(
        "select * from public.invoices where id=$1",
        [vatId],
        adminId,
      )
    )[0];
    assert.equal(vi.vat_total, 20);
    assert.equal(vi.gross_total, 2620);
    assert.equal(
      (
        await request(
          "select * from public.invoices where id=$1",
          [invoiceId],
          adminId,
        )
      )[0].snapshot.company.vat_registered,
      false,
    );
  });
  await test("remove used staff revokes existing access and keeps history; unused account purge is guarded", async () => {
    await request("select public.remove_staff($1,true)", [salesId], adminId);
    assert.equal(
      (await request("select * from public.orders", [], salesId)).length,
      0,
    );
    assert.equal(
      (
        await request(
          "select full_name from public.users where id=$1",
          [salesId],
          adminId,
        )
      )[0].full_name,
      "Alex Morgan",
    );
    await assert.rejects(
      () =>
        request(
          "select public.purge_unused_staff($1,true)",
          [salesId],
          adminId,
        ),
      /history|dependencies/,
    );
    await assert.rejects(
      () => request("select public.remove_staff($1,true)", [adminId], adminId),
      /yourself|own/i,
    );
    await assert.rejects(
      () =>
        request(
          "insert into public.customers(first_name,last_name,assigned_to) values('New','Customer',$1)",
          [salesId],
          adminId,
        ),
      /active staff/,
    );
    const unused = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      unused,
      "unused@example.test",
    ]);
    await request("select public.remove_staff($1,true)", [unused], adminId);
    await request(
      "select public.purge_unused_staff($1,true)",
      [unused],
      adminId,
    );
    assert.equal(
      (
        await request(
          "select * from public.users where id=$1",
          [unused],
          adminId,
        )
      ).length,
      0,
    );
  });
  console.log(`${count} Phase 5.1 database/PDF checks passed`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.close();
}
