// Extends the existing HTTP fixture with actual Phase 3 SQL/RLS. Never imported by application code.
import { orderDatabase, salesId } from "./order-backend.mjs";
export async function orderFixture(tables, objects, snapshot) {
  const { db, request } = await orderDatabase();
  const names = [
    "products",
    "orders",
    "measurements",
    "prescriptions",
    "order_items",
    "payments",
    "order_files",
    "order_events",
    "order_status_history",
    "order_aftercare",
    "manufacturer_packs",
    "tasks",
  ];
  async function syncCustomers() {
    for (const c of tables.customers)
      await db.query(
        "insert into public.customers(id,first_name,last_name,email,practice_name) values($1,$2,$3,$4,$5) on conflict(id) do update set first_name=excluded.first_name,last_name=excluded.last_name,email=excluded.email,practice_name=excluded.practice_name",
        [c.id, c.first_name, c.last_name, c.email ?? "", c.practice_name ?? ""],
      );
  }
  async function syncActivities() {
    const rows = await request(
      "select * from public.activities where order_id is not null",
    );
    for (const row of rows)
      if (!tables.activities.some((a) => a.id === row.id))
        tables.activities.push(row);
  }
  // Optional local demo restore: retain records and product references across restarts.
  // Catalogue options always come from the current migrations.
  if (snapshot) {
    await db.exec("set session_replication_role=replica");
    await syncCustomers();
    for (const p of snapshot.products ?? [])
      await db.query("update public.products set id=$1 where sku=$2", [
        p.id,
        p.sku,
      ]);
    for (const table of names.filter((n) => n !== "products")) {
      const rows = snapshot[table] ?? [];
      if (!rows.length) continue;
      const columns = (
        await db.query(
          "select column_name from information_schema.columns where table_schema='public' and table_name=$1 and is_generated='NEVER' order by ordinal_position",
          [table],
        )
      ).rows
        .filter((r) => Object.hasOwn(rows[0], r.column_name))
        .map((r) => `"${r.column_name}"`)
        .join(",");
      await db.query(
        `insert into public.${table} (${columns}) overriding system value select ${columns} from jsonb_populate_recordset(null::public.${table},$1::jsonb)`,
        [JSON.stringify(rows)],
      );
    }
    await db.query(
      "select setval(pg_get_serial_sequence('public.orders','order_number'),greatest(coalesce((select max(order_number) from public.orders),0),1),(select count(*)>0 from public.orders))",
    );
    for (const f of snapshot.order_files ?? [])
      await db.query(
        "insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)",
        [
          f.storage_bucket ?? "order-prescriptions",
          f.storage_path,
          f.uploaded_by,
        ],
      );
  }
  if (snapshot) await db.exec("set session_replication_role=origin");
  if (snapshot && !snapshot.order_events) {
    await db.query(
      "insert into public.order_events(order_id,kind,description,user_id,created_at) select id,'Order created','Restored demo order',created_by,created_at from public.orders",
    );
    await db.query(
      "insert into public.order_events(order_id,kind,description,user_id,created_at) select id,'Order confirmed','Order confirmed',confirmed_by,confirmed_at from public.orders where confirmed_at is not null",
    );
    await db.query(
      "insert into public.order_status_history(order_id,to_status,user_id,created_at) select id,status,confirmed_by,confirmed_at from public.orders where confirmed_at is not null",
    );
  }
  return async (req, url, body, bytes, json, res) => {
    const endpoint = url.pathname.split("/").at(-1);
    try {
      if (
        url.pathname.startsWith("/storage/v1/object/") &&
        (url.pathname.includes("order-prescriptions") ||
          url.pathname.includes("order-attachments"))
      ) {
        const path = decodeURIComponent(url.pathname)
          .replace("/storage/v1/object/authenticated/", "")
          .replace("/storage/v1/object/", "");
        const bucket = path.split("/")[0];
        const name = path.slice(bucket.length + 1);
        if (req.method === "POST") {
          await request(
            "insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)",
            [bucket, name, salesId],
          );
          objects.set(path, bytes);
          json({ Key: path });
          return true;
        }
        if (req.method === "GET") {
          const allowed = await request(
            "select id from storage.objects where bucket_id=$1 and name=$2",
            [bucket, name],
          );
          if (!allowed.length) {
            json({ message: "Not found" }, 404);
            return true;
          }
          res.writeHead(200, { "Content-Type": "application/pdf" });
          res.end(objects.get(path));
          return true;
        }
        if (req.method === "DELETE") {
          for (const prefix of body.prefixes ?? []) {
            await request(
              "delete from storage.objects where bucket_id=$1 and name=$2",
              [bucket, prefix],
            );
            objects.delete(`${bucket}/${prefix}`);
          }
          json([]);
          return true;
        }
      }
      if (
        url.pathname.startsWith("/rest/v1/rpc/") &&
        [
          "save_order",
          "register_order_file",
          "remove_order_file",
          "operate_order",
        ].includes(endpoint)
      ) {
        await syncCustomers();
        let rows;
        if (endpoint === "operate_order")
          rows = await request(
            "select public.operate_order($1,$2,$3::jsonb,$4) result",
            [
              body.target,
              body.operation,
              JSON.stringify(body.payload),
              body.request_id,
            ],
          );
        if (endpoint === "save_order")
          rows = await request(
            "select public.save_order($1,$2::jsonb,$3,$4) result",
            [
              body.p_id,
              JSON.stringify(body.p_payload),
              body.p_expected_version,
              body.p_confirm ?? false,
            ],
          );
        if (endpoint === "register_order_file")
          rows = await request(
            "select public.register_order_file($1,$2,$3,$4,$5,$6) result",
            [
              body.target,
              body.path,
              body.label,
              body.mime,
              body.bytes,
              body.expected_version,
            ],
          );
        if (endpoint === "remove_order_file")
          rows = await request(
            "select public.remove_order_file($1,$2) result",
            [body.target, body.expected_version],
          );
        await syncActivities();
        for (const task of await request(
          "select * from public.tasks where order_id is not null",
        )) {
          const old = tables.tasks.find((t) => t.id === task.id);
          if (old) Object.assign(old, task);
          else tables.tasks.push(task);
        }
        json(rows[0].result);
        return true;
      }
      if (
        url.pathname.startsWith("/rest/v1/") &&
        names.includes(endpoint) &&
        (endpoint !== "tasks" || url.searchParams.has("order_id"))
      ) {
        const args = [],
          clauses = [];
        for (const [key, value] of url.searchParams) {
          if (value.startsWith("eq.") && /^[a-z_]+$/.test(key)) {
            args.push(value.slice(3));
            clauses.push(`"${key}"::text=$${args.length}`);
          }
        }
        let sql = `select * from public.${endpoint}${clauses.length ? " where " + clauses.join(" and ") : ""}`;
        const order = url.searchParams.get("order");
        if (order) {
          const parts = order
            .split(",")
            .filter((p) => /^[a-z_]+\.(asc|desc)$/.test(p));
          if (parts.length)
            sql +=
              " order by " + parts.map((p) => p.replace(".", " ")).join(",");
        }
        const rows = await request(sql, args);
        const count = rows.length;
        const offset = Number(url.searchParams.get("offset") ?? 0),
          limit = Number(url.searchParams.get("limit") ?? 1000);
        const result = rows.slice(offset, offset + limit);
        res.setHeader(
          "Content-Range",
          `0-${Math.max(0, result.length - 1)}/${count}`,
        );
        json(
          req.headers.accept?.includes("vnd.pgrst.object")
            ? (result[0] ?? null)
            : result,
        );
        return true;
      }
      return false;
    } catch (error) {
      json({ message: error.message, code: error.code ?? "P0001" }, 400);
      return true;
    }
  };
}
