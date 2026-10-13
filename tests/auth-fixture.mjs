// Dedicated synthetic Auth/REST service for integration tests; binds only to loopback.
// It simulates email delivery and tokens, never a production authentication provider.
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { orderDatabase, adminId, salesId } from "./order-backend.mjs";
const { db, request } = await orderDatabase({scanFit:Boolean(process.env.PHASE_SCAN_FIT_DEMO),clientScan:Boolean(process.env.PHASE_CLIENT_SCAN_DEMO)});
let failNextScanReviewResponse=false;
const accounts = new Map(),
  sessions = new Map(),
  refreshes = new Map(),
  mail = [];
const fixturePort = Number(process.env.FIXTURE_PORT || 54330);
const objects = new Map();
const serviceKey = "auth-fixture-service-key";
const password = "Fixture-password-123!";
for (const [id, email] of [
  [adminId, "admin@example.test"],
  [salesId, "sales@example.test"],
]) {
  accounts.set(id, { id, email, password, confirmed: true, banned: false });
  await db.query("update auth.users set email=$2 where id=$1", [id, email]);
}
const cid = randomUUID(),
  oid = randomUUID();
await db.query(
  "insert into public.customers(id,first_name,last_name,assigned_to) values($1,'Demo','Customer',$2)",
  [cid, salesId],
);
await db.query(
  "insert into public.orders(id,customer_id,created_by) values($1,$2,$3)",
  [oid, cid, salesId],
);
if (process.env.PHASE5_DEMO) {
  const product = (
    await request("select * from public.products where name='EL'")
  )[0];
  const payload = {
    customer_id: cid,
    current_step: 7,
    measurements: {
      right_bd: 31,
      left_bd: 32,
      working_distance: 450,
      notes: "Synthetic demo",
    },
    prescription: {
      required: false,
      right_eye: {},
      left_eye: {},
      prescription_date: "",
      provider: "",
      notes: "",
    },
    items: [
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
          magnification: "4x",
          frame: "Sport",
          frame_colour: "Black",
          working_distance: 450,
          manufacturer_instructions: "",
        },
      },
    ],
    payments: [],
  };
  if (process.env.PHASE6_DEMO) {
    payload.prescription = {
      required: true,
      right_eye: { sphere: -1, cylinder: -0.5, axis: 90 },
      left_eye: { sphere: -1.25, cylinder: -0.25, axis: 80 },
      prescription_date: "2026-09-01",
      provider: "TEST ONLY",
      notes: "Synthetic prescription attached",
    };
    payload.items[0].configuration.manufacturer_instructions =
      "TEST ONLY - align optical centres";
    const extra = await request(
      "select * from public.products where sku in ('LIGHT-WIRELESS','BATTERY-STARTER','CASE-STARTER')",
    );
    for (const p of extra)
      payload.items.push({
        ...payload.items[0],
        id: randomUUID(),
        product_id: p.id,
        unit_price: 100,
        configuration: {},
      });
    const file = await readFile(
        new URL("./fixtures/media/test-prescription.pdf", import.meta.url),
      ),
      fid = randomUUID(),
      path = cid + "/" + fid + "/original";
    await request(
      "select public.reserve_media($1,$2,$3,$4::jsonb)",
      [
        fid,
        cid,
        oid,
        JSON.stringify({
          filename: "TEST-prescription.pdf",
          mime_type: "application/pdf",
          size_bytes: file.length,
          sha256: createHash("sha256").update(file).digest("hex"),
          category: "Prescription",
          visibility: "Shareable",
          description: "Synthetic Phase 6 demonstration",
        }),
      ],
      salesId,
    );
    await db.query(
      "insert into storage.objects(bucket_id,name,metadata) values('crm-media',$1,$2::jsonb)",
      [path, JSON.stringify({ size: file.length })],
    );
    objects.set("crm-media/" + path, file);
    await db.transaction(async (tx) => {
      await tx.exec("set local role service_role");
      await tx.query("select public.finish_media($1,false,$2)", [fid, salesId]);
    });
  }
  await request(
    "select public.save_order($1,$2::jsonb,1,true)",
    [oid, JSON.stringify(payload)],
    salesId,
  );
}
const publicUser = (a) => ({
  id: a.id,
  email: a.email,
  aud: "authenticated",
  role: "authenticated",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: new Date().toISOString(),
});
async function token(a) {
  const access_token = [
    { alg: "HS256", typ: "JWT" },
    {
      sub: a.id,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: randomUUID(),
    },
    "fixture",
  ]
    .map((v) =>
      Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString(
        "base64url",
      ),
    )
    .join(".");
  const refresh_token = randomUUID();
  sessions.set(access_token, a.id);
  refreshes.set(refresh_token, a.id);
  await db.query("update auth.users set last_sign_in_at=now() where id=$1", [
    a.id,
  ]);
  return {
    access_token,
    refresh_token,
    expires_in: 3600,
    token_type: "bearer",
    user: publicUser(a),
  };
}
function sendMail(a, type) {
  const token_hash = randomUUID() + randomUUID();
  mail.push({ email: a.email, type, token_hash, user_id: a.id, used: false });
}
let requestQueue = Promise.resolve();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1"),
    bearer = req.headers.authorization?.replace(/^Bearer /, ""),
    actor = sessions.get(bearer),
    isService = bearer === serviceKey;
  let body = {};
  const bytes = [];
  for await (const b of req) bytes.push(b);
  try {
    body = JSON.parse(Buffer.concat(bytes).toString() || "{}");
  } catch {}
  const json = (data, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Range": `0-999/${Array.isArray(data) ? data.length : 1}`,
    });
    res.end(JSON.stringify(data));
  };
  let unlock;
  const previous = requestQueue;
  requestQueue = new Promise((resolve) => {
    unlock = resolve;
  });
  await previous;
  try {
    if (url.pathname === "/__state")
      return json({ customer_id: cid, order_id: oid });
    if (url.pathname === "/health") return json({ ok: true });
    if(url.pathname==="/__fail-next-scan-review-response"&&process.env.PHASE_SCAN_FIT_DEMO){failNextScanReviewResponse=true;return json({ok:true});}
    if (url.pathname === "/__mail") return json(mail);
    if (url.pathname === "/__advance-email-limit") {
      await db.query(
        "update public.auth_email_limits set requested_at=now()-interval '2 minutes'",
      );
      return json({ ok: true });
    }
    if (url.pathname === "/__history")
      return json((await db.query("select * from public.audit_logs")).rows);
    if (url.pathname === "/auth/v1/token") {
      const a = body.refresh_token
        ? accounts.get(refreshes.get(body.refresh_token))
        : [...accounts.values()].find(
            (a) => a.email === body.email && a.password === body.password,
          );
      return a && !a.banned && a.confirmed
        ? json(await token(a))
        : json({ message: "Invalid login credentials" }, 400);
    }
    if (url.pathname === "/auth/v1/invite" && isService) {
      let a = [...accounts.values()].find((a) => a.email === body.email);
      if (a?.confirmed) return json({ message: "Already registered" }, 422);
      if (!a) {
        a = {
          id: randomUUID(),
          email: body.email,
          confirmed: false,
          banned: false,
          password: null,
        };
        accounts.set(a.id, a);
        await db.query(
          "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",
          [a.id, a.email, JSON.stringify(body.data ?? {})],
        );
      }
      sendMail(a, "invite");
      return json(publicUser(a));
    }
    if (url.pathname.startsWith("/auth/v1/admin/users/") && isService) {
      const a = accounts.get(url.pathname.split("/").at(-1));
      if (!a) return json({ message: "Not found" }, 404);
      if (req.method === "DELETE") {
        await db.query("delete from auth.users where id=$1", [a.id]);
        accounts.delete(a.id);
        return json({});
      }
      if (body.email) a.email = body.email;
      if (body.ban_duration) a.banned = body.ban_duration !== "none";
      await db.query("update auth.users set email=$2 where id=$1", [
        a.id,
        a.email,
      ]);
      return json({ user: publicUser(a) });
    }
    if (url.pathname === "/auth/v1/recover") {
      const a = [...accounts.values()].find((a) => a.email === body.email);
      if (a && !a.banned) sendMail(a, "recovery");
      return json({});
    }
    if (url.pathname === "/auth/v1/verify") {
      const m = mail.find(
        (m) =>
          m.token_hash === body.token_hash && m.type === body.type && !m.used,
      );
      if (!m) return json({ message: "Expired link" }, 403);
      const a = accounts.get(m.user_id);
      if (a.banned) return json({ message: "Inactive" }, 403);
      m.used = true;
      a.confirmed = true;
      return json(await token(a));
    }
    if (url.pathname === "/auth/v1/user") {
      const a = accounts.get(actor);
      if (!a || a.banned) return json({ message: "Invalid session" }, 401);
      if (req.method === "PUT" && body.password) {
        a.password = body.password;
        await db.query(
          "update auth.users set encrypted_password=$2 where id=$1",
          [a.id, `fixture-hash-${randomUUID()}`],
        );
      }
      return json(publicUser(a));
    }
    if (url.pathname === "/auth/v1/logout") {
      for (const [t, id] of sessions)
        if (
          t === bearer ||
          (url.searchParams.get("scope") !== "local" && id === actor)
        )
          sessions.delete(t);
      for (const [t, id] of refreshes) if (id === actor) refreshes.delete(t);
      return json({});
    }
    if (url.pathname.startsWith("/storage/v1/object/list/")) {
      if (!actor) return json({ message: "Denied" }, 403);
      const bucket = url.pathname.split("/").at(-1);
      if (
        ![
          "invoices",
          "company-assets",
          "customer-files",
          "crm-media",
          "order-prescriptions",
          "order-attachments",
        ].includes(bucket)
      )
        return json({ message: "Missing bucket" }, 404);
      await request(
        "select id from storage.objects where bucket_id=$1 limit 1",
        [bucket],
        actor,
      );
      return json([]);
    }
    if (url.pathname.startsWith("/storage/v1/object/")) {
      const path = decodeURIComponent(url.pathname)
        .replace("/storage/v1/object/authenticated/", "")
        .replace("/storage/v1/object/", "");
      const bucket = path.split("/")[0],
        name = path.slice(bucket.length + 1);
      if(req.method==="DELETE"&&isService){const names=Array.isArray(body.prefixes)?body.prefixes:[];await db.query("delete from storage.objects where bucket_id=$1 and name=any($2::text[])",[bucket,names]);for(const name of names)objects.delete(bucket+"/"+name);return json(names.map(name=>({name})));}
      const storageRun = (sql, args) =>
        isService
          ? db.query(sql, args).then((r) => r.rows)
          : request(sql, args, actor ?? null);
      if (req.method === "POST") {
        if (objects.has(path)) return json({ message: "Already exists" }, 409);
        await storageRun(
          "insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4::jsonb)",
          [
            bucket,
            name,
            actor,
            JSON.stringify({ size: Buffer.concat(bytes).length }),
          ],
          actor ?? null,
        );
        objects.set(path, Buffer.concat(bytes));
        return json({ Key: path });
      }
      if (req.method === "GET") {
        const allowed = await storageRun(
          "select id from storage.objects where bucket_id=$1 and name=$2",
          [bucket, name],
          actor ?? null,
        );
        if (!allowed.length) return json({ message: "Not found" }, 404);
        const data = objects.get(path);
        if (!data) return json({ message: "Not found" }, 404);
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
        const start = range ? Number(range[1]) : 0;
        const end =
          range && range[2]
            ? Math.min(Number(range[2]), data.length - 1)
            : data.length - 1;
        if (start > end || start >= data.length) {
          res.writeHead(416, { "Content-Range": `bytes */${data.length}` });
          return res.end();
        }
        res.writeHead(range ? 206 : 200, {
          "Content-Type": "application/octet-stream",
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          ...(range
            ? { "Content-Range": `bytes ${start}-${end}/${data.length}` }
            : {}),
        });
        return res.end(data.subarray(start, end + 1));
      }
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const rpc = url.pathname.includes("/rpc/"),
        name = url.pathname.split("/").at(-1);
      const run = async (sql, args = []) =>
        isService
          ? db.transaction(async (tx) => {
              await tx.exec("set local role service_role");
              return (await tx.query(sql, args)).rows;
            })
          : request(sql, args, actor ?? null);
      if (rpc) {
        const allowed = {
          scan_fit_operate: ["actor","operation","payload"],
          scan_fit_issue_client_link: ["actor","payload"],
          scan_fit_client_authorize: ["link_hash","operation","payload"],
          scan_fit_revoke_client_link: ["actor","target"],
          save_product: ["target","payload"],
          report_data: ["filters"],
          record_report_export: ["filters","format"],
          media_config: [],
          media_scope: ["customer", "related_order"],
          search_media: ["filters"],
          reserve_media: ["target", "customer", "related_order", "details"],
          finish_media: ["target", "has_thumbnail", "actor"],
          edit_media: ["target", "details"],
          link_media: ["target", "related_order"],
          media_shareable: ["target"],
          review_manufacturer: ["target", "selected", "instructions"],
          reserve_manufacturer: [
            "target",
            "request_id",
            "selected",
            "instructions",
            "expected",
          ],
          finish_manufacturer: ["target", "bytes", "sha", "actor"],
          prepare_document_package: [
            "target",
            "related_order",
            "customer",
            "audience",
            "selected",
          ],
          configure_media: ["settings"],
          remove_staff: ["target", "confirmed"],
          purge_unused_staff: ["target", "confirmed"],
          set_manufacturing_window: [
            "target",
            "from_date",
            "to_date",
            "reason",
            "new_order_date",
          ],
          save_company_settings: ["payload", "verified"],
          invoice_preview: ["target", "supplied", "pay_by", "note"],
          reserve_invoice: ["target", "supplied", "pay_by", "note", "expected"],
          finalize_invoice: ["target", "actor", "path", "sha"],
          cancel_invoice_draft: ["target", "reason"],
          has_permission: ["p_permission"],
          finance_operation: ["target", "operation", "payload", "request_id"],
          order_financial_summary: ["target"],
          customer_financial_summary: ["target"],
          search_payments: ["filters"],
          configure_finance: ["requirement"],
          system_health: [],
          save_order: ["p_id", "p_payload", "p_expected_version", "p_confirm"],
          operate_order: ["target", "operation", "payload", "request_id"],
          search_customers: [
            "term",
            "status_filter",
            "assignee",
            "sort_key",
            "page_number",
          ],
          save_customer: [
            "payload",
            "addresses",
            "customer_id",
            "allow_duplicate",
          ],
          register_order_file: [
            "target",
            "path",
            "label",
            "mime",
            "bytes",
            "expected_version",
          ],
          remove_order_file: ["target", "expected_version"],
          edit_staff: [
            "target",
            "first_name",
            "last_name",
            "mobile",
            "new_role",
            "is_active",
          ],
          staff_auth_event: ["target", "event"],
          claim_auth_email: ["key_hash"],
          consume_password_grant: ["proof"],
          staff_sales_summary: [],
        };
        if (!allowed[name]) return json({ message: "Unknown RPC" }, 404);
        const keys = allowed[name].filter((k) => body[k] !== undefined);
        const rows = await run(
          name === "search_customers"
            ? `select to_jsonb(result) result from public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) result`
            : `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) result`,
          keys.map((k) =>
            Array.isArray(body[k])
              ? body[k]
              : typeof body[k] === "object" && body[k] !== null
                ? JSON.stringify(body[k])
                : body[k],
          ),
        );
        if(name==="scan_fit_operate"&&body.operation==="review"&&failNextScanReviewResponse){failNextScanReviewResponse=false;return json({message:"Simulated lost response after committed review"},503);}
        return json(
          name === "search_customers"
            ? rows.map((row) => row.result)
            : rows[0].result,
        );
      }
      if (
        ![
          "scan_fit_frame_profiles","scan_fit_config","scan_fit_sessions","scan_fit_frames","scan_fit_results","scan_fit_validation","scan_fit_adjustments",
          "users",
          "staff_profiles",
          "password_grants",
          "role_permissions",
          "customers",
          "orders",
          "products",
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
          "activities",
          "files",
          "customer_addresses",
          "lead_sources",
          "finance_settings",
          "invoices",
          "company_settings",
          "media_files",
          "media_categories",
          "media_settings",
          "media_order_links",
          "media_events",
          "document_packages",
        ].includes(name)
      )
        return json({ message: "Unknown table" }, 404);
      if (req.method === "POST" && name === "password_grants") {
        const r = await run(
          "insert into public.password_grants(digest,user_id,expires_at) values($1,$2,$3) returning *",
          [body.digest, body.user_id, body.expires_at],
        );
        return json(r, 201);
      }
      if(req.method==="POST"&&["activities","tasks"].includes(name)){
        const record=Array.isArray(body)?body[0]:body;
        const fields=name==="activities"?["customer_id","order_id","type","description","user_id"]:["customer_id","order_id","title","description","assigned_to","created_by","due_date","priority"];
        const keys=fields.filter(k=>record[k]!==undefined);
        if(!keys.length)return json({message:"Missing fields"},400);
        const rows=await run(`insert into public.${name}(${keys.join(",")}) values(${keys.map((_,i)=>"$"+(i+1)).join(",")}) returning *`,keys.map(k=>record[k]));
        return json(rows,201);
      }
      if(req.method==="PATCH"&&name==="tasks"){
        const taskId=url.searchParams.get("id");
        if(!taskId?.startsWith("eq.")||typeof body.completed!=="boolean")return json({message:"Invalid task update"},400);
        return json(await run("update public.tasks set completed=$1 where id=$2 returning *",[body.completed,taskId.slice(3)]));
      }
      const params = [],
        where = [];
      for (const [k, v] of url.searchParams) {
        if (["select", "order", "limit", "offset"].includes(k)) continue;
        if (!/^[a-z_]+$/.test(k)) throw Error("Invalid field");
        if (v.startsWith("neq.")) {
          params.push(v.slice(4));
          where.push(`${k}<>$${params.length}`);
        }
        if (v.startsWith("in.(")) {
          const values = v.slice(4, -1).split(",");
          where.push(
            `${k} in (${values
              .map((value) => {
                params.push(value);
                return "$" + params.length;
              })
              .join(",")})`,
          );
        }
        if (v.startsWith("eq.")) {
          const value = v.slice(3);
          params.push(
            value === "true" ? true : value === "false" ? false : value,
          );
          where.push(`${k}=$${params.length}`);
        }
      }
      const select = url.searchParams.get("select") ?? "*";
      if (!/^[a-z_,*]+$/.test(select)) throw Error("Invalid select");
      const sorts = (url.searchParams.get("order") ?? "")
        .split(",")
        .filter(Boolean)
        .map((v) => {
          const [k, direction] = v.split(".");
          if (!/^[a-z_]+$/.test(k)) throw Error("Invalid sort");
          return k + (direction === "desc" ? " desc" : " asc");
        })
        .join(",");
      const limit = Math.min(
          1000,
          Math.max(1, Number(url.searchParams.get("limit") ?? 1000)),
        ),
        offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
      const rows = await run(
        `select ${select} from public.${name}${where.length ? " where " + where.join(" and ") : ""}${sorts ? " order by " + sorts : ""} limit ${limit} offset ${offset}`,
        params,
      );
      return req.headers.accept?.includes("vnd.pgrst.object")
        ? rows.length === 1
          ? json(rows[0])
          : json({ code: "PGRST116", message: "No row" }, 406)
        : json(rows);
    }
    json({ message: "Not found" }, 404);
  } catch (error) {
    json(
      {
        code: error.code,
        message: error.code === "P0001" ? error.message : "Request rejected",
      },
      403,
    );
  } finally {
    unlock();
  }
});
server.listen(fixturePort, "127.0.0.1", () =>
  console.log(`Synthetic auth fixture ready on ${fixturePort}`),
);
