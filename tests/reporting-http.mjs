// Exercises real Next Server Actions over HTTP with the dedicated synthetic Auth fixture.
// Run demo:phase6, then media-http.mjs. This script generates packs and a synthetic invoice.
import assert from "node:assert/strict";
const origin = process.env.APP_TEST_URL || "http://127.0.0.1:3007";
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
const fixture = "http://127.0.0.1:54334",
  manifest = JSON.parse(
    await readFile(
      ".next-phase7-final/server/server-reference-manifest.json",
      "utf8",
    ),
  );
const admin = jar(),
  sales = jar();
await login(admin, "admin@example.test", "Fixture-password-123!");
await login(sales, "sales@example.test", "Fixture-password-123!");
const token = await (
  await fetch(fixture + "/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({
      email: "admin@example.test",
      password: "Fixture-password-123!",
    }),
  })
).json();
async function rest(path, body) {
  const res = await fetch(fixture + "/rest/v1/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token.access_token,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await res.json();
  assert.ok(res.ok, JSON.stringify(value));
  return value;
}
async function action(name, args) {
  const id = Object.entries(manifest.node).find(
    ([, v]) => v.exportedName === name,
  )?.[0];
  assert.ok(id, name);
  const r = await admin.request("/orders/new", {
    method: "POST",
    headers: {
      "Next-Action": id,
      "Content-Type": "text/plain;charset=UTF-8",
      Accept: "text/x-component",
    },
    body: JSON.stringify(args),
  });
  assert.equal(r.status, 200);
  const m = r.html.match(/^1:(.+)$/m);
  assert.ok(m, r.html);
  const value = JSON.parse(m[1]);
  assert.ok(!value.error, JSON.stringify(value));
  return value;
}
let count = 0;
async function test(name, fn) {
  await fn();
  console.log("PASS", name);
  count++;
}
const state = await (await fetch(fixture + "/__state")).json();
const customer = state.customer_id,
  products = await rest("products?select=*");
const et = products.find((p) => p.system_code === "LOUPE-ET"),
  adapt = products.find((p) => p.system_code === "LOUPE-ET2-3IN1");
async function createOrder(product, price, cid = customer) {
  const id = randomUUID();
  const input = {
    customer_id: cid,
    current_step: 7,
    measurements: {
      right_bd: 31,
      left_bd: 32,
      working_distance: 450,
      notes: "TEST Phase 7",
    },
    prescription: {
      required: false,
      right_eye: {
        sphere: null,
        cylinder: null,
        axis: null,
        add: null,
        prism: null,
      },
      left_eye: {
        sphere: null,
        cylinder: null,
        axis: null,
        add: null,
        prism: null,
      },
      prescription_date: "",
      provider: "",
      notes: "",
    },
    items: [
      {
        id: randomUUID(),
        product_id: product.id,
        quantity: 1,
        unit_price: price,
        discount_type: "none",
        discount_value: 0,
        discount_reason: "",
        vat_rate: 0,
        vat_applicable: false,
        configuration: {
          magnification: product.options.magnification[0],
          frame: "Sport",
          frame_colour: "Black",
          working_distance: 450,
          manufacturer_instructions: "TEST manufacturing identity",
        },
      },
    ],
    payments: [],
  };
  return action("saveOrder", [id, 0, input, true]);
}
const created = {};
await test("login, navigation, dashboard and reporting carry Elevate branding", async () => {
  const loginPage = await jar().get("/login");
  assert.ok(loginPage.html.includes("Elevate Dental Optics"));
  const home = await admin.get("/");
  assert.ok(home.html.includes("ELEVATE DASHBOARD"));
  assert.ok(home.html.includes('href="/reports"'));
  assert.ok((await admin.get("/reports")).html.includes("Management reports"));
});
await test("ET1, ET2 and unmapped EL display correctly; confirmed lines retain manufacturer identity", async () => {
  const page = await admin.get("/orders/new");
  for (const name of ["ELEVATE ADAPT", "ELEVATE ERGO", "EL"])
    assert.ok(page.html.includes(name));
  created.adapt = (await createOrder(adapt, 2500)).id;
  created.ergo = (await createOrder(et, 2000)).id;
  const lines = await rest("order_items?order_id=eq." + created.adapt);
  assert.equal(lines[0].product_identity.manufacturer_model, "ET2 3-in-1");
  assert.equal(lines[0].description, "ET2 3-in-1 / ELEVATE ADAPT™");
  assert.ok(
    (await admin.get("/orders/" + created.adapt)).html.includes(
      "ELEVATE ADAPT",
    ),
  );
});
await test("manufacturer PDF is rebranded and uses a finance-free original-model snapshot", async () => {
  const review = await rest("rpc/review_manufacturer", {
    target: created.adapt,
    selected: [],
    instructions: "TEST Phase 7",
  });
  assert.equal(review.snapshot.items[0].manufacturer_model, "ET2 3-in-1");
  assert.equal(review.snapshot.items[0].commercial_name, "ADAPT");
  const pack = await action("generateManufacturer", [
    {
      id: randomUUID(),
      order: created.adapt,
      files: [],
      instructions: "TEST Phase 7",
      fingerprint: review.fingerprint,
    },
  ]);
  const pdf = await admin.get("/media/" + pack.id);
  assert.equal(pdf.status, 200);
  await writeFile("output/pdf/phase7-manufacturer.pdf", pdf.bytes);
  created.pack = pack.id;
  const files = await rest("media_files?id=eq." + pack.id);
  assert.ok(files[0].filename.startsWith("Elevate-"));
});
await rest("rpc/save_company_settings", {
  payload: {
    legal_name: "Manareta Ltd",
    trading_name: "Elevate Dental Optics",
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
const row = (await rest("customers?id=eq." + customer))[0];
await rest("rpc/save_customer", {
  payload: { ...row, delivery_address_same_as_customer: true },
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
await test("issued invoice preserves Manareta legal supplier and Elevate product description", async () => {
  const path = "/orders/" + created.adapt + "/invoice",
    page = await admin.get(path);
  assert.ok(page.html.includes("Manareta Ltd"));
  assert.ok(page.html.includes("Elevate Dental Optics"));
  const issued = await submit(admin, path, page.html, (f) =>
    f.includes("Issue Invoice"),
  );
  assert.match(issued.location, /^\/invoices\//, issued.html);
  created.invoice = issued.location.split("/").at(-1);
  const i = (await rest("invoices?id=eq." + created.invoice))[0];
  assert.equal(i.snapshot.company.legal_name, "Manareta Ltd");
  assert.equal(i.snapshot.company.trading_name, "Elevate Dental Optics");
  assert.ok(i.snapshot.lines[0].description.includes("ET2 3-in-1"));
  const pdf = await admin.get("/invoice-files/" + created.invoice);
  assert.equal(pdf.status, 200);
  await writeFile("output/pdf/phase7-invoice.pdf", pdf.bytes);
});
const date = new Date().toISOString().slice(0, 10),
  params = new URLSearchParams({
    preset: "Custom",
    from: date.slice(0, 7) + "-01",
    to: date,
  });
await test("filtered CSV totals match the same live report RPC and PDF export", async () => {
  const report = await rest("rpc/report_data", {
    filters: Object.fromEntries(params),
  });
  const csv = await admin.get("/api/reports/export?" + params + "&format=csv");
  assert.equal(csv.status, 200);
  assert.ok(
    csv.html.includes(
      '"total_order_value","' + report.sales.total_order_value + '"',
    ),
  );
  assert.ok(csv.html.includes('"ET2 3-in-1"'));
  assert.equal(csv.headers.get("cache-control"), "private, no-store");
  const pdf = await admin.get("/api/reports/export?" + params + "&format=pdf");
  assert.equal(pdf.status, 200);
  assert.equal(pdf.bytes.subarray(0, 5).toString(), "%PDF-");
  await writeFile("output/pdf/phase7-live-management-report.pdf", pdf.bytes);
  const single = await admin.get(
    "/api/reports/export?" + params + "&product=" + adapt.id + "&format=csv",
  );
  assert.ok(single.html.includes('"total_order_value","2500"'));
});
await test("direct export URLs enforce authentication, role checks and input validation", async () => {
  const none = await jar().get("/api/reports/export?" + params);
  assert.ok(none.location?.includes("/login"));
  const bad = await admin.get(
    "/api/reports/export?preset=Custom&from=2026-10-01&to=2026-09-01",
  );
  assert.equal(bad.status, 400);
  const wrong = await sales.get("/settings/products");
  assert.ok(wrong.location?.includes("/forbidden"));
  const mine = await sales.get(
    "/api/reports/export?" +
      params +
      "&rep=22222222-2222-4222-8222-222222222222",
  );
  assert.equal(mine.status, 200);
  assert.ok(mine.html.includes('"orders","0"'));
});
await test("report exports create audit records with filters and actor, without document contents", async () => {
  const history = await (await fetch(fixture + "/__history")).json();
  assert.ok(
    history.filter((a) => a.action === "EXPORT" && a.entity_type === "reports")
      .length >= 3,
  );
  for (const a of history.filter((a) => a.action === "EXPORT")) {
    assert.ok(a.user_id);
    assert.ok(a.new_value.filters);
    assert.ok(!JSON.stringify(a).includes("sphere"));
  }
});
await writeFile(
  "/tmp/elevate-phase7-acceptance.json",
  JSON.stringify({ ...state, ...created }),
);
console.log(`${count} Phase 7 HTTP acceptance checks passed.`);
