// Isolated local demo/browser-test fixture. No production data or credentials.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { orderFixture } from "./order-fixture.mjs";
import { randomUUID } from "node:crypto";
const staff = {
  id: "11111111-1111-4111-8111-111111111111",
  full_name: "Alex Morgan",
  role: "sales",
  active: true,
  created_at: new Date().toISOString(),
};
const user = {
  id: staff.id,
  aud: "authenticated",
  role: "authenticated",
  email: "staff@example.test",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: staff.created_at,
};
const jwt = () =>
  [
    { alg: "HS256", typ: "JWT" },
    {
      sub: staff.id,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    "fixture",
  ]
    .map((x) =>
      Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString(
        "base64url",
      ),
    )
    .join(".");
const tables = {
  users: [staff],
  role_permissions: [
    "customers.read",
    "crm.read",
    "crm.write",
    "orders.read",
    "orders.write",
    "orders.clinical",
    "orders.manage",
    "orders.pay",
    "orders.manufacturer",
  ].map((permission) => ({ role: "sales", permission })),
  lead_sources: ["Website", "Referral", "Dental Show", "Other"].map((name) => ({
    name,
    active: true,
  })),
  customers: [],
  customer_addresses: [],
  activities: [],
  tasks: [],
  files: [],
};
const objects = new Map();
let orderSnapshot;
if (process.env.DEMO_SNAPSHOT) {
  const snapshot = JSON.parse(
    await readFile(process.env.DEMO_SNAPSHOT, "utf8"),
  );
  orderSnapshot = snapshot._orders;
  for (const key of [
    "customers",
    "customer_addresses",
    "activities",
    "tasks",
    "files",
  ])
    if (snapshot[key]) tables[key] = snapshot[key];
  for (const [key, value] of Object.entries(snapshot._objects ?? {}))
    objects.set(key, Buffer.from(value, "base64"));
}
const handleOrder = await orderFixture(tables, objects, orderSnapshot);
function matches(row, url) {
  for (const [key, value] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (value.startsWith("eq.") && String(row[key]) !== value.slice(3))
      return false;
    if (
      value.startsWith("in.") &&
      !value.slice(4, -1).split(",").includes(String(row[key]))
    )
      return false;
    if (value.startsWith("lt.") && String(row[key]) >= value.slice(3))
      return false;
  }
  return true;
}
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    let body = {};
    try {
      body = JSON.parse(bytes.toString() || "{}");
    } catch {}
    const json = (value, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Range": `0-999/${Array.isArray(value) ? value.length : 1}`,
      });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/health") return json({ ok: true });
    if (await handleOrder(req, url, body, bytes, json, res)) return;
    if (url.pathname === "/auth/v1/token")
      return body.password === "fixture-password" ||
        body.refresh_token === "fixture-refresh"
        ? json({
            access_token: jwt(),
            refresh_token: "fixture-refresh",
            token_type: "bearer",
            expires_in: 3600,
            user,
          })
        : json({ message: "Invalid login credentials" }, 400);
    if (url.pathname === "/auth/v1/user") return json(user);
    if (url.pathname === "/auth/v1/logout") return json({});
    if (url.pathname.startsWith("/storage/v1/object/")) {
      const path = decodeURIComponent(url.pathname)
        .replace("/storage/v1/object/authenticated/", "")
        .replace("/storage/v1/object/", "");
      if (req.method === "POST") {
        objects.set(path, bytes);
        return json({ Key: path });
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        return res.end(objects.get(path));
      }
      return json({});
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.split("/").at(-1);
      if (name === "has_permission")
        return json(
          [
            "customers.read",
            "crm.read",
            "crm.write",
            "orders.read",
            "orders.write",
            "orders.clinical",
            "orders.manage",
            "orders.pay",
            "orders.manufacturer",
          ].includes(body.p_permission),
        );
      if (name === "search_customers") {
        let rows = tables.customers.filter(
          (c) =>
            (!body.status_filter || c.status === body.status_filter) &&
            (!body.assignee || c.assigned_to === body.assignee) &&
            (!body.term ||
              Object.values(c)
                .join(" ")
                .toLowerCase()
                .includes(body.term.toLowerCase())),
        );
        const count = rows.length;
        rows = rows.slice(
          ((body.page_number || 1) - 1) * 20,
          (body.page_number || 1) * 20,
        );
        return json(rows.map((c) => ({ ...c, total_count: count })));
      }
      if (name === "save_customer") {
        const p = body.payload;
        if (!body.customer_id && !body.allow_duplicate) {
          const dup = tables.customers.filter(
            (c) =>
              (p.email && c.email === p.email) ||
              (p.mobile && c.mobile === p.mobile) ||
              (c.first_name === p.first_name &&
                c.last_name === p.last_name &&
                c.practice_name === p.practice_name),
          );
          if (dup.length) return json({ duplicates: dup });
        }
        let c = tables.customers.find((c) => c.id === body.customer_id);
        if (!c) {
          c = {
            id: randomUUID(),
            customer_number: tables.customers.length + 1,
            created_at: new Date().toISOString(),
          };
          tables.customers.push(c);
        }
        Object.assign(c, p, { updated_at: new Date().toISOString() });
        tables.customer_addresses = tables.customer_addresses.filter(
          (a) => a.customer_id !== c.id,
        );
        tables.customer_addresses.push(
          ...body.addresses.map((a) => ({
            ...a,
            id: randomUUID(),
            customer_id: c.id,
          })),
        );
        return json({ id: c.id });
      }
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const name = url.pathname.split("/").at(-1);
      const table = tables[name];
      if (!table) return json({ message: "Unknown fixture table" }, 404);
      if (req.method === "POST") {
        const row = {
          id: randomUUID(),
          created_at: new Date().toISOString(),
          user_id: staff.id,
          uploaded_by: staff.id,
          completed: false,
          ...body,
        };
        table.push(row);
        return json(row, 201);
      }
      let rows = table.filter((row) => matches(row, url));
      if (req.method === "PATCH")
        rows.forEach((row) => Object.assign(row, body));
      if (url.searchParams.get("order")?.includes("created_at.desc"))
        rows.reverse();
      return json(
        req.headers.accept?.includes("vnd.pgrst.object")
          ? (rows[0] ?? null)
          : rows,
      );
    }
    json({ message: "Unknown fixture route", path: url.pathname }, 404);
  })
  .listen(54329, "127.0.0.1", () =>
    console.log("Browser fixture ready on 54329"),
  );
