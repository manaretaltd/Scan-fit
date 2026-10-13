import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  orderDatabase,
  adminId,
  salesId,
  opsId,
  financeId,
} from "./order-backend.mjs";
import { emptyDraft, blankConfiguration } from "../src/lib/orders/model";
const { db, request } = await orderDatabase();
let count = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  console.log("PASS", name);
  count++;
}
const customer = randomUUID(),
  order = randomUUID(),
  other = randomUUID(),
  otherOrder = randomUUID();
const sha = "a".repeat(64);
const rpc = async (name: string, args: unknown[] = [], actor = adminId) =>
  (
    await request(
      `select public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) value`,
      args,
      actor,
    )
  )[0]?.value;
const service = async (name: string, args: unknown[]) =>
  db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return (
      await tx.query<{ value: unknown }>(
        `select public.${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) value`,
        args,
      )
    ).rows[0]?.value;
  });
async function upload(
  category = "Measurement",
  visibility = "Shareable",
  oid: string | null = order,
) {
  const id = randomUUID();
  const details = {
    filename: "TEST-" + category + ".pdf",
    mime_type: "application/pdf",
    size_bytes: 100,
    category,
    visibility,
    sha256: sha,
    description: "Synthetic test document",
  };
  await rpc("reserve_media", [id, customer, oid, JSON.stringify(details)]);
  const [f] = await request(
    "select * from public.media_files where id=$1",
    [id],
    adminId,
  );
  await db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
    "crm-media",
    f.storage_path,
  ]);
  await service("finish_media", [id, false, adminId]);
  return { id, f, details };
}
try {
  await db.query(
    "insert into public.customers(id,first_name,last_name,assigned_to) values($1,'Synthetic','Media',$2),($3,'Unrelated','Customer',$4)",
    [customer, salesId, other, adminId],
  );
  await db.query(
    "insert into public.orders(id,customer_id,created_by,status,confirmed_at,confirmed_by) values($1,$2,$3,'Order Confirmed',now(),$3),($4,$5,$6,'Order Confirmed',now(),$6)",
    [order, customer, salesId, otherOrder, other, adminId],
  );
  let image!: Awaited<ReturnType<typeof upload>>;
  await test("private bucket, extensible categories, central limits and no client writes", async () => {
    assert.equal(
      (
        await db.query<{ public: boolean }>(
          "select public from storage.buckets where id='crm-media'",
        )
      ).rows[0].public,
      false,
    );
    assert.equal((await rpc("media_config")).categories.length, 13);
    await assert.rejects(() =>
      request("update public.media_settings set image_limit=999999"),
    );
    await assert.rejects(() =>
      request(
        "insert into storage.objects(bucket_id,name) values('crm-media','forged')",
      ),
    );
  });
  await test("service-validated upload creates one file, linked activity and audit", async () => {
    image = await upload();
    assert.equal(
      (
        await request("select status from public.media_files where id=$1", [
          image.id,
        ])
      )[0].status,
      "Active",
    );
    assert.equal(
      (
        await request("select * from public.media_events where file_id=$1", [
          image.id,
        ])
      ).length,
      1,
    );
    assert.equal(
      (
        await request(
          "select * from public.order_events where media_file_id=$1",
          [image.id],
        )
      ).length,
      1,
    );
    assert.ok(
      (
        await request(
          "select * from public.audit_logs where entity_id=$1",
          [image.id],
          adminId,
        )
      ).length >= 2,
    );
    await assert.rejects(
      () => rpc("finish_media", [image.id, false, adminId]),
      /permission denied/,
    );
  });
  await test("retry is idempotent, changed content/metadata conflicts", async () => {
    assert.equal(
      await rpc("reserve_media", [
        image.id,
        customer,
        order,
        JSON.stringify(image.details),
      ]),
      image.id,
    );
    await service("finish_media", [image.id, false, adminId]);
    assert.equal(
      (
        await request("select * from public.media_events where file_id=$1", [
          image.id,
        ])
      ).length,
      1,
    );
    await assert.rejects(
      () =>
        rpc("reserve_media", [
          image.id,
          customer,
          order,
          JSON.stringify({ ...image.details, description: "changed" }),
        ]),
      /conflict/,
    );
  });
  await test("role and record scope block metadata, storage and clinical snapshots", async () => {
    for (const actor of [opsId, financeId]) {
      assert.equal(
        (
          await request(
            "select * from public.media_files where id=$1",
            [image.id],
            actor,
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await request(
            "select * from storage.objects where name=$1",
            [image.f.storage_path],
            actor,
          )
        ).length,
        0,
      );
    }
    await assert.rejects(
      () =>
        rpc(
          "reserve_media",
          [randomUUID(), other, otherOrder, JSON.stringify(image.details)],
          salesId,
        ),
      /Permission denied/,
    );
    await assert.rejects(
      () => rpc("review_manufacturer", [order, [], ""], opsId),
      /Permission denied/,
    );
    const restrictedId = randomUUID();
    await rpc("reserve_media", [
      restrictedId,
      other,
      otherOrder,
      JSON.stringify(image.details),
    ]);
    const [restricted] = await request(
      "select * from public.media_files where id=$1",
      [restrictedId],
      adminId,
    );
    await db.query(
      "insert into storage.objects(bucket_id,name) values($1,$2)",
      ["crm-media", restricted.storage_path],
    );
    await service("finish_media", [restrictedId, false, adminId]);
    assert.equal(
      (
        await request(
          "select * from public.media_files where id=$1",
          [restrictedId],
          salesId,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await request(
          "select * from storage.objects where name=$1",
          [restricted.storage_path],
          salesId,
        )
      ).length,
      0,
    );
  });
  await test("validation rejects oversized, executable, cross-customer order and payment mismatch", async () => {
    for (const details of [
      { ...image.details, size_bytes: 999999999 },
      { ...image.details, mime_type: "application/x-msdownload" },
      { ...image.details, payment_id: randomUUID() },
    ])
      await assert.rejects(() =>
        rpc("reserve_media", [
          randomUUID(),
          customer,
          order,
          JSON.stringify(details),
        ]),
      );
    await assert.rejects(() =>
      rpc("reserve_media", [
        randomUUID(),
        customer,
        otherOrder,
        JSON.stringify(image.details),
      ]),
    );
  });
  const customerFile = await upload("Customer", "Internal Only", null);
  await test("existing customer file links to order without another physical object", async () => {
    await rpc("link_media", [customerFile.id, order]);
    await rpc("link_media", [customerFile.id, order]);
    assert.equal(
      (
        await request(
          "select * from public.media_order_links where file_id=$1",
          [customerFile.id],
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await request("select * from storage.objects where name=$1", [
          customerFile.f.storage_path,
        ])
      ).length,
      1,
    );
    await assert.rejects(
      () => rpc("link_media", [customerFile.id, otherOrder]),
      /Permission denied/,
    );
  });
  await test("paginated search filters and strips storage paths", async () => {
    const r = await rpc("search_media", [
      JSON.stringify({
        customer,
        order,
        q: "Synthetic",
        category: "Measurement",
        type: "application",
        uploader: adminId,
      }),
    ]);
    assert.equal(r.total, 1);
    assert.equal(r.items[0].id, image.id);
    assert.ok(!("storage_path" in r.items[0]));
    assert.ok(!("sha256" in r.items[0]));
  });
  const internal = await upload("Prescription", "Internal Only");
  const financial = await upload("Finance", "Shareable");
  await test("manufacturer review excludes Internal Only and Finance, including deliberate selection", async () => {
    for (const id of [internal.id, financial.id])
      await assert.rejects(
        () => rpc("review_manufacturer", [order, [id], ""]),
        /Only permitted/,
      );
    await assert.rejects(
      () => rpc("operate_order", [order, "manufacturer", "{}", randomUUID()]),
      /reviewed/,
    );
  });
  await rpc("edit_media", [
    internal.id,
    JSON.stringify({ visibility: "Shareable" }),
  ]);
  const selection = [image.id, internal.id];
  let first: string;
  let second: string;
  async function generate() {
    const r = await rpc("review_manufacturer", [
      order,
      selection,
      "TEST manufacturing instructions",
    ]);
    const id = randomUUID();
    await rpc("reserve_manufacturer", [
      order,
      id,
      selection,
      "TEST manufacturing instructions",
      r.fingerprint,
    ]);
    await db.query(
      "insert into storage.objects(bucket_id,name) values('crm-media',$1)",
      [customer + "/" + id + "/manufacturer.pdf"],
    );
    await service("finish_manufacturer", [id, 500, sha, adminId]);
    return id;
  }
  await test("review uses an explicit finance-free snapshot; stale reviews cannot generate", async () => {
    const r = await rpc("review_manufacturer", [order, selection, "TEST"]);
    assert.ok(!JSON.stringify(r.snapshot).includes("payments"));
    assert.ok(!JSON.stringify(r.snapshot).includes("unit_price"));
    await rpc("edit_media", [
      image.id,
      JSON.stringify({ description: "Updated measurement" }),
    ]);
    await assert.rejects(
      () =>
        rpc("reserve_manufacturer", [
          order,
          randomUUID(),
          selection,
          "TEST",
          r.fingerprint,
        ]),
      /changed/,
    );
  });
  await test("generated manufacturer PDF registers privately with activity and preserved version", async () => {
    first = await generate();
    const [pack] = await request(
      "select * from public.manufacturer_packs where id=$1",
      [first],
      adminId,
    );
    assert.equal(pack.version, 1);
    assert.equal(pack.generated_file_id, first);
    assert.equal(
      (
        await request(
          "select * from public.media_files where id=$1",
          [first],
          opsId,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await request(
          "select * from public.manufacturer_packs where id=$1",
          [first],
          opsId,
        )
      ).length,
      0,
    );
    await assert.rejects(
      () => rpc("edit_media", [first, JSON.stringify({ status: "Archived" })]),
      /historical/,
    );
  });
  await test("changed order creates v2 and preserves v1 snapshot and original object", async () => {
    await db.query(
      "update public.orders set manufacturer_reference='TEST-V2' where id=$1",
      [order],
    );
    second = await generate();
    const p = await request(
      "select * from public.manufacturer_packs where order_id=$1 order by version",
      [order],
      adminId,
    );
    assert.equal(p.length, 2);
    assert.equal(p[0].version, 1);
    assert.equal(p[1].version, 2);
    assert.notEqual(
      p[0].snapshot.manufacturer_reference,
      p[1].snapshot.manufacturer_reference,
    );
    assert.equal(
      (
        await request(
          "select * from storage.objects where name=$1",
          [customer + "/" + first + "/manufacturer.pdf"],
          adminId,
        )
      ).length,
      1,
    );
  });
  await test("manufacturer package selects latest pack and all approved original supplements", async () => {
    const id = await rpc("prepare_document_package", [
      randomUUID(),
      order,
      customer,
      "Manufacturer",
      [],
    ]);
    const [p] = await request(
      "select * from public.document_packages where id=$1",
      [id],
      adminId,
    );
    assert.equal(p.pack_id, second);
    assert.deepEqual([...p.file_ids].sort(), [second, ...selection].sort());
    assert.equal(p.status, "Prepared");
    await assert.rejects(
      () =>
        rpc("prepare_document_package", [
          randomUUID(),
          order,
          customer,
          "Manufacturer",
          [financial.id],
        ]),
      /cannot be sent/,
    );
  });
  await test("revoked sharing approval prevents later package preparation and archive preserves objects", async () => {
    await rpc("edit_media", [
      internal.id,
      JSON.stringify({ visibility: "Internal Only" }),
    ]);
    assert.equal(await rpc("media_shareable", [second]), false);
    await assert.rejects(
      () =>
        rpc("prepare_document_package", [
          randomUUID(),
          order,
          customer,
          "Manufacturer",
          [],
        ]),
      /Shareable/,
    );
    await rpc("edit_media", [image.id, JSON.stringify({ status: "Archived" })]);
    assert.equal(
      (
        await request(
          "select * from storage.objects where name=$1",
          [image.f.storage_path],
          adminId,
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await rpc("search_media", [
          JSON.stringify({ order, status: "Archived" }),
        ])
      ).total,
      1,
    );
    await request(
      "delete from storage.objects where name=$1",
      [image.f.storage_path],
      adminId,
    );
    assert.equal(
      (
        await db.query("select * from storage.objects where name=$1", [
          image.f.storage_path,
        ])
      ).rows.length,
      1,
    );
  });
  await test("wizard confirmation accepts a private prescription uploaded through the unified file registry", async () => {
    const draftId = randomUUID();
    await db.query(
      "insert into public.orders(id,customer_id,created_by) values($1,$2,$3)",
      [draftId, customer, salesId],
    );
    const draft = emptyDraft(customer);
    draft.measurements = {
      right_bd: 31,
      left_bd: 32,
      working_distance: 450,
      notes: "Registry integration",
    };
    draft.prescription.required = true;
    const [product] = await request(
      "select * from public.products where name='EL'",
    );
    draft.items = [
      {
        id: randomUUID(),
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
          working_distance: 450,
        },
      },
    ];
    await upload("Prescription", "Internal Only", draftId);
    const result = await rpc(
      "save_order",
      [draftId, JSON.stringify(draft), 1, true],
      salesId,
    );
    assert.equal(result.status, "Order Confirmed");
    assert.equal(
      (
        await request("select * from public.order_files where order_id=$1", [
          draftId,
        ])
      ).length,
      0,
    );
  });
  await test("deactivation immediately revokes database and storage access", async () => {
    await db.query("update public.users set active=false where id=$1", [
      salesId,
    ]);
    assert.equal(
      (await request("select * from public.media_files", [], salesId)).length,
      0,
    );
    assert.equal(
      (await request("select * from storage.objects", [], salesId)).length,
      0,
    );
    await assert.rejects(
      () =>
        rpc(
          "reserve_media",
          [randomUUID(), customer, order, JSON.stringify(image.details)],
          salesId,
        ),
      /Permission denied/,
    );
  });
  await test("System Health checks private media bucket and RLS without exposing files", async () => {
    const checks = await rpc("system_health");
    assert.ok(
      checks.some(
        (c: { component: string; status: string }) =>
          c.component === "Secure File Storage" && c.status === "Healthy",
      ),
    );
    assert.ok(!JSON.stringify(checks).includes(image.f.storage_path));
  });
  console.log(`${count} media database checks passed.`);
} finally {
  await db.close();
}
