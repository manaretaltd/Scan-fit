// Exercises real Next Server Actions over HTTP with the dedicated synthetic Auth fixture.
// Run demo:phase51 and issue a synthetic invoice first. Set INVOICE_TEST_ID.
import assert from "node:assert/strict";
const origin = process.env.APP_TEST_URL || "http://127.0.0.1:3003";
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

const invoiceId = process.env.INVOICE_TEST_ID;
assert.ok(invoiceId, "Set INVOICE_TEST_ID to an issued synthetic test invoice");
const admin = jar(),
  anon = jar();
assert.equal(
  (await login(admin, "admin@example.test", "Fixture-password-123!")).status,
  303,
);
const page = await admin.get(`/invoices/${invoiceId}`);
assert.equal(page.status, 200);
assert.match(page.html, /MAN-INV/);
assert.match(page.html, /Manareta Ltd/);
const first = await admin.get(`/invoice-files/${invoiceId}`);
assert.equal(first.status, 200);
assert.equal(first.headers.get("content-type"), "application/pdf");
assert.equal(first.bytes.subarray(0, 5).toString(), "%PDF-");
assert.ok(first.bytes.length > 1500);
assert.equal(first.headers.get("cache-control"), "private, no-store");
const second = await admin.get(`/invoice-files/${invoiceId}?download=1`);
assert.deepEqual(first.bytes, second.bytes);
assert.match(second.headers.get("content-disposition"), /attachment/);
const orderLink = page.html.match(/href="(\/orders\/[a-f0-9-]+)"/)[1];
const customerLink = page.html.match(
  /href="(\/customers\/[a-f0-9-]+)\?tab=invoices"/,
)[1];
assert.ok(
  (await admin.get(orderLink + "?tab=invoices")).html.includes(invoiceId),
);
assert.ok(
  (await admin.get(customerLink + "?tab=invoices")).html.includes(invoiceId),
);
const reopened = jar();
await login(reopened, "admin@example.test", "Fixture-password-123!");
assert.deepEqual(
  (await reopened.get(`/invoice-files/${invoiceId}`)).bytes,
  first.bytes,
);
const blocked = await anon.get(`/invoice-files/${invoiceId}`);
assert.notEqual(blocked.headers.get("content-type"), "application/pdf");
assert.ok([303, 307].includes(blocked.status));
console.log(
  "PASS invoice page supplier/number, secure inline PDF, download byte identity, order link, customer link, new-session persistence, anonymous denial (7 checks)",
);

// Phase 6: one authoritative object appears in both file workspaces.
const media=await admin.get(`/media/${invoiceId}?preview=1`);
assert.equal(media.status,200);assert.deepEqual(media.bytes,first.bytes);
for(const filter of ['order='+orderLink.split('/').at(-1),'customer='+customerLink.split('/').at(-1)]){
 const list=JSON.parse((await admin.get('/api/media?'+filter+'&category=Invoice')).html);
 assert.ok(list.items.some(f=>f.id===invoiceId&&f.source==='Invoice'));
}
console.log('PASS authoritative invoice PDF also appears in order and customer Files (3 checks)');
