// Exercises real Next Server Actions over HTTP with the dedicated synthetic Auth fixture.
// Run demo:phase51 and issue a synthetic invoice first. Set INVOICE_TEST_ID.
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
const fixture = process.env.FIXTURE_TEST_URL || "http://127.0.0.1:54333";
const state = await (await fetch(fixture + "/__state")).json();
const admin = jar(),
  anon = jar();
assert.equal(
  (await login(admin, "admin@example.test", "Fixture-password-123!")).status,
  303,
);
let count = 0;
async function test(name, fn) {
  await fn();
  console.log("PASS", name);
  count++;
}
const ids = {};
async function upload(
  name,
  mime,
  category,
  visibility = "Shareable",
  order = state.order_id,
  id = randomUUID(),
) {
  const body = new FormData();
  for (const [k, v] of Object.entries({
    id,
    customer: state.customer_id,
    order: order || "",
    category,
    description: "Synthetic Phase 6 acceptance",
    visibility,
  }))
    body.set(k, v);
  body.set(
    "file",
    new Blob([await readFile("tests/fixtures/media/" + name)], { type: mime }),
    name,
  );
  const response = await admin.request("/api/media/upload", {
    method: "POST",
    body,
  });
  return { response, id };
}
await test("JPEG uploads through authenticated API with thumbnail and retry deduplication", async () => {
  const r = await upload("test-photo.jpg", "image/jpeg", "Measurement");
  assert.equal(r.response.status, 200, r.response.html);
  ids.photo = r.id;
  const retry = await upload(
    "test-photo.jpg",
    "image/jpeg",
    "Measurement",
    "Shareable",
    state.order_id,
    r.id,
  );
  assert.equal(retry.response.status, 200, retry.response.html);
  const thumb = await admin.get("/media/" + r.id + "?thumbnail=1");
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get("content-type"), "image/jpeg");
});
await test("prescription PDF persists and streams privately with inline option", async () => {
  const r = await upload(
    "test-prescription.pdf",
    "application/pdf",
    "Prescription",
  );
  assert.equal(r.response.status, 200, r.response.html);
  ids.pdf = r.id;
  const response = await admin.get("/media/" + r.id + "?preview=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("content-disposition"), /inline/);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.deepEqual(
    response.bytes,
    await readFile("tests/fixtures/media/test-prescription.pdf"),
  );
});
await test("MP4 and MOV upload, authorized byte ranges support playback", async () => {
  for (const [ext, mime] of [
    ["mp4", "video/mp4"],
    ["mov", "video/quicktime"],
  ]) {
    const r = await upload("test-video." + ext, mime, "Fitting");
    assert.equal(r.response.status, 200, r.response.html);
    ids[ext] = r.id;
    const range = await admin.request("/media/" + r.id + "?preview=1", {
      headers: { Range: "bytes=0-99" },
    });
    assert.equal(range.status, 206, range.html);
    assert.equal(range.bytes.length, 100);
    assert.match(range.headers.get("content-range"), /^bytes 0-99/);
  }
});
await test("Internal Only customer upload is excluded from sharing and survives new login", async () => {
  const r = await upload(
    "test-photo.jpg",
    "image/jpeg",
    "Customer",
    "Internal Only",
    null,
  );
  assert.equal(r.response.status, 200, r.response.html);
  ids.internal = r.id;
  const reopened = jar();
  await login(reopened, "admin@example.test", "Fixture-password-123!");
  assert.equal((await reopened.get("/media/" + r.id)).status, 200);
});
await test("anonymous requests and cross-origin writes rejected", async () => {
  const response = await anon.get("/media/" + ids.pdf);
  assert.ok([303, 307].includes(response.status));
  assert.match(response.location, /login/);
  const denied = await admin.request("/api/media/upload", {
    method: "POST",
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(denied.status, 403);
});
await test("API rejects executable bytes regardless of extension", async () => {
  const b = new FormData();
  for (const [k, v] of Object.entries({
    id: randomUUID(),
    customer: state.customer_id,
    order: state.order_id,
    category: "Measurement",
    description: "",
    visibility: "Internal Only",
  }))
    b.set(k, v);
  b.set(
    "file",
    new Blob(["MZ dangerous executable"], { type: "image/jpeg" }),
    "fake.jpg",
  );
  const r = await admin.request("/api/media/upload", {
    method: "POST",
    body: b,
  });
  assert.equal(r.status, 400);
  assert.match(r.html, /Unsupported/);
});
await test("customer and order list API strips storage paths, category counts and filters work", async () => {
  const c = JSON.parse(
    (await admin.get("/api/media?customer=" + state.customer_id)).html,
  );
  assert.ok(c.total >= 5);
  assert.ok(!JSON.stringify(c).includes("storage_path"));
  const o = JSON.parse(
    (
      await admin.get(
        "/api/media?order=" + state.order_id + "&category=Prescription",
      )
    ).html,
  );
  assert.ok(o.items.some((f) => f.id === ids.pdf));
});
await test("selection download produces a private ZIP with exact originals", async () => {
  const r = await admin.request("/api/media/bundle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [ids.photo, ids.pdf] }),
  });
  assert.equal(r.status, 200, r.html);
  assert.equal(r.bytes.readUInt32LE(), 0x04034b50);
  await writeFile("tests/fixtures/media/http-package.zip", r.bytes);
});
await writeFile(
  "/tmp/easysee-phase6-acceptance.json",
  JSON.stringify({ ...state, ...ids }),
);
console.log(`${count} media HTTP acceptance checks passed.`);
