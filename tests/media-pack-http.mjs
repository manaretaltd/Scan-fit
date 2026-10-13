// Exercises real Next Server Actions over HTTP with the dedicated synthetic Auth fixture.
// Run demo:phase6, then media-http.mjs. This script generates packs and a synthetic invoice.
import assert from "node:assert/strict";
const origin = process.env.APP_TEST_URL || "http://127.0.0.1:3006";
const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
function jar() {
  const cookies = new Map();
  return {
    async get(path) {
      return this.request(path);
    },
    async request(path, options = {}) {
      const r = await fetch(new URL(path, origin), {
        ...options,
        redirect: "manual",
        headers: {
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          Origin: origin,
          ...options.headers,
        },
      });
      for (const c of r.headers.getSetCookie()) {
        const [kv] = c.split(";"),
          i = kv.indexOf("=");
        cookies.set(kv.slice(0, i), kv.slice(i + 1));
      }
      const bytes = Buffer.from(await r.arrayBuffer());
      const html = bytes.toString();
      const streamed = html.match(/<meta[^>]+content="[^"]*?url=([^"]+)"/);
      return {
        status: r.status,
        headers: r.headers,
        bytes,
        location: r.headers.get("location") ?? streamed?.[1] ?? null,
        html,
      };
    },
  };
}
function form(html, predicate) {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(
    (m) => m[0],
  );
  const f = forms.find(predicate);
  assert.ok(f, "Expected form exists");
  return f;
}
async function submit(client, path, html, predicate, values = {}) {
  const f = form(html, predicate),
    body = new FormData();
  for (const m of f.matchAll(/<input\b[^>]*>/g)) {
    const n = m[0].match(/\bname="([^"]*)"/),
      v = m[0].match(/\bvalue="([^"]*)"/);
    if (n) body.append(decode(n[1]), decode(v?.[1] ?? ""));
  }
  for (const [k, v] of Object.entries(values)) body.set(k, String(v));
  return client.request(path, { method: "POST", body });
}
async function login(client, email, password) {
  const p = await client.get("/login");
  return submit(client, "/login", p.html, (f) => f.includes("Log In"), {
    email,
    password,
  });
}

const { readFile, writeFile } = await import("node:fs/promises");
const { randomUUID } = await import("node:crypto");
const state = JSON.parse(
  await readFile("/tmp/easysee-phase6-acceptance.json", "utf8"),
);
const manifest = JSON.parse(
  await readFile(
    (process.env.APP_TEST_DIST || ".next-phase6-final") +
      "/server/server-reference-manifest.json",
    "utf8",
  ),
);
const fixture = process.env.FIXTURE_TEST_URL || "http://127.0.0.1:54333";
const session = await (
  await fetch(fixture + "/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({
      email: "admin@example.test",
      password: "Fixture-password-123!",
    }),
  })
).json();
async function rest(path, body) {
  const r = await fetch(fixture + "/rest/v1/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + session.access_token,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  assert.ok(r.ok, JSON.stringify(j));
  return j;
}
async function action(name, path, args) {
  const id = Object.entries(manifest.node).find(
    ([, v]) => v.exportedName === name,
  )?.[0];
  assert.ok(id, name);
  const r = await admin.request(path, {
    method: "POST",
    headers: {
      "Next-Action": id,
      "Content-Type": "text/plain;charset=UTF-8",
      Accept: "text/x-component",
    },
    body: JSON.stringify(args),
  });
  assert.equal(r.status, 200, r.html);
  const match = r.html.match(/^1:(.+)$/m);
  assert.ok(match, r.html);
  const result = JSON.parse(match[1]);
  assert.ok(!result.error, JSON.stringify(result));
  return result;
}
const admin = jar();
await login(admin, "admin@example.test", "Fixture-password-123!");
let count = 0;
async function test(name, fn) {
  await fn();
  console.log("PASS", name);
  count++;
}
const order = state.order_id,
  customer = state.customer_id;
let packs = await rest(
  "manufacturer_packs?order_id=eq." + order + "&order=version.asc",
);
if (!packs.length) {
  const files = [state.photo, state.pdf, state.mp4, state.mov];
  const review = await rest("rpc/review_manufacturer", {
    target: order,
    selected: files,
    instructions: "TEST FIRST VERSION",
  });
  await action("generateManufacturer", "/orders/" + order + "/manufacturer", [
    {
      id: randomUUID(),
      order,
      files,
      instructions: "TEST FIRST VERSION",
      fingerprint: review.fingerprint,
    },
  ]);
  packs = await rest(
    "manufacturer_packs?order_id=eq." + order + "&order=version.asc",
  );
}
const first = packs[0];
let original;
let second;
await test("server-action manufacturer PDF persists privately with activity and finance-free snapshot", async () => {
  const r = await admin.get("/media/" + first.generated_file_id);
  assert.equal(r.status, 200);
  original = r.bytes;
  await writeFile("output/pdf/phase6-live-manufacturer-v1.pdf", r.bytes);
  assert.equal(r.bytes.subarray(0, 5).toString(), "%PDF-");
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  const raw = JSON.stringify(first.snapshot);
  for (const f of ["unit_price", "gross_total", "payments", "discount"])
    assert.ok(!raw.includes(f));
  assert.equal(first.snapshot.prescription.required, true);
  assert.equal(first.snapshot.measurements.total_bd, 63);
  assert.ok(first.snapshot.items.some((i) => i.sku === "LIGHT-WIRELESS"));
  assert.ok((await rest("order_events?media_file_id=eq." + first.id)).length);
});
await test("editing manufacturer reference creates v2 and keeps v1 bytes and snapshot", async () => {
  await rest("rpc/operate_order", {
    target: order,
    operation: "details",
    payload: { manufacturer_reference: "TEST-V2-REF" },
    request_id: randomUUID(),
  });
  const review = await rest("rpc/review_manufacturer", {
    target: order,
    selected: first.file_ids,
    instructions: "TEST VERSION TWO",
  });
  const r = await action(
    "generateManufacturer",
    "/orders/" + order + "/manufacturer",
    [
      {
        id: randomUUID(),
        order,
        files: first.file_ids,
        instructions: "TEST VERSION TWO",
        fingerprint: review.fingerprint,
      },
    ],
  );
  second = r.id;
  const all = await rest(
    "manufacturer_packs?order_id=eq." + order + "&order=version.asc",
  );
  assert.ok(all.length >= 2);
  assert.equal(all.at(-1).snapshot.manufacturer_reference, "TEST-V2-REF");
  assert.deepEqual((await admin.get("/media/" + first.id)).bytes, original);
  await writeFile(
    "output/pdf/phase6-live-manufacturer-v2.pdf",
    (await admin.get("/media/" + second)).bytes,
  );
});
await test("prepared ZIP uses latest version and includes approved video originals", async () => {
  const r = await action(
    "preparePackage",
    "/orders/" + order + "/manufacturer",
    [
      {
        id: randomUUID(),
        customer,
        order,
        audience: "Manufacturer",
        files: [],
      },
    ],
  );
  const pkg = (await rest("document_packages?id=eq." + r.id))[0];
  assert.equal(pkg.pack_id, second);
  assert.ok(pkg.file_ids.includes(state.mp4));
  assert.ok(!pkg.file_ids.includes(state.internal));
  const download = await admin.get("/document-packages/" + r.id);
  assert.equal(download.status, 200, download.html);
  await writeFile("tests/fixtures/media/manufacturer-live.zip", download.bytes);
  state.package = r.id;
  state.pack = second;
});
await test("manufacturer generation and package preparation have attributable audit entries", async () => {
  const history = await (await fetch(fixture + "/__history")).json();
  for (const type of ["media_files", "manufacturer_packs", "document_packages"])
    assert.ok(
      history.some((a) => a.entity_type === type && a.user_id),
      "missing " + type,
    );
});
await test("non-destructive System Health reports media, PDF and authenticated storage capabilities", async () => {
  const before = (await rest("media_files?select=id")).length;
  const checks = await action("runSystemCheck", "/settings/system-health", []);
  for (const component of [
    "Secure File Storage",
    "Prescription Storage",
    "Photo Upload",
    "Video Upload",
    "PDF Generation",
    "Manufacturer Pack Generation",
    "Signed URL Generation",
  ])
    assert.ok(
      checks.some(
        (c) => c.component.includes(component) && c.status === "Healthy",
      ),
      component + JSON.stringify(checks),
    );
  assert.equal((await rest("media_files?select=id")).length, before);
  await writeFile(
    "/tmp/easysee-phase6-health.json",
    JSON.stringify(checks, null, 2),
  );
});
// Prepare clearly-labelled synthetic billing data for invoice UI acceptance.
await rest("rpc/save_company_settings", {
  payload: {
    legal_name: "Manareta Ltd",
    trading_name: process.env.TEST_TRADING_NAME || "Easysee UK",
    address: "TEST ONLY - 1 Example Street, London, TEST 1AA",
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
    payment_details: "TEST ONLY - do not pay",
    payment_terms: "Test invoice",
    footer: "Synthetic acceptance document. Not a real tax invoice.",
    logo_path: "",
  },
  verified: true,
});
const customerRow = (await rest("customers?id=eq." + customer))[0];
await rest("rpc/save_customer", {
  payload: { ...customerRow, delivery_address_same_as_customer: true },
  addresses: [
    {
      kind: "Practice",
      line1: "TEST ONLY - 10 Sample Road",
      city: "London",
      county: "Test County",
      postcode: "TEST 2BB",
      country: "United Kingdom",
    },
  ],
  customer_id: customer,
  allow_duplicate: true,
});
await test("invoice issuance succeeds after media generation and registers the authoritative PDF", async () => {
  const page = await admin.get("/orders/" + order + "/invoice");
  const issued = await submit(
    admin,
    "/orders/" + order + "/invoice",
    page.html,
    (f) => f.includes("Issue Invoice"),
  );
  assert.match(issued.location, /^\/invoices\//, issued.html);
  state.invoice = issued.location.split("/").at(-1);
  const f = (await rest("media_files?invoice_id=eq." + state.invoice))[0];
  assert.equal(f.storage_bucket, "invoices");
  assert.equal(f.source, "Invoice");
});
await writeFile("/tmp/easysee-phase6-acceptance.json", JSON.stringify(state));
console.log(`${count} manufacturer/health HTTP checks passed.`);
