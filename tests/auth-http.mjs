// Exercises real Next Server Actions over HTTP with the dedicated synthetic Auth fixture.
// Start tests/auth-fixture.mjs and Next on 3001 using the fixture environment first.
import assert from "node:assert/strict";
const origin = process.env.APP_TEST_URL || "http://127.0.0.1:3001",
  fixture = process.env.FIXTURE_TEST_URL || "http://127.0.0.1:54330";
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
      const html = await r.text();
      const streamed = html.match(/<meta[^>]+content="[^"]*?url=([^"]+)"/);
      return {
        status: r.status,
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
const admin = jar(),
  rep = jar(),
  anon = jar(),
  password = "Fixture-password-123!";
let checks = 0;
async function check(name, run) {
  await run();
  console.log("PASS", name);
  checks++;
}
let target,
  email = `new-rep-${Date.now()}@example.test`;
await check("administrator login and protected Users page", async () => {
  const r = await login(admin, "admin@example.test", password);
  assert.equal(r.status, 303);
  const p = await admin.get("/settings/users");
  assert.equal(p.status, 200);
  assert.match(p.html, /Staff accounts/);
});
await check(
  "administrator invites sales representative; no password field or plaintext password email",
  async () => {
    const p = await admin.get("/settings/users");
    const r = await submit(
      admin,
      "/settings/users",
      p.html,
      (f) => f.includes("Send invitation"),
      {
        first_name: "Sarah",
        last_name: "Jones",
        email,
        mobile: "07700900123",
        role: "sales",
        active: "true",
      },
    );
    assert.match(r.html, /Invitation sent/);
    const mail = await (await fetch(fixture + "/__mail")).json();
    target = mail.find((m) => m.email === email);
    assert.equal(target.type, "invite");
    assert.ok(!JSON.stringify(target).includes(password));
  },
);
await check("administrator resends a pending invitation", async () => {
  await fetch(fixture + "/__advance-email-limit");
  const p = await admin.get("/settings/users");
  const r = await submit(
    admin,
    "/settings/users",
    p.html,
    (f) =>
      f.includes(`value="${target.user_id}"`) &&
      f.includes("Resend invitation"),
  );
  assert.match(r.html, /Email requested successfully/);
  const mail = await (await fetch(fixture + "/__mail")).json();
  target = mail.findLast((m) => m.email === email && m.type === "invite");
});
await check(
  "invitation verifies once and creates password with a user-bound grant",
  async () => {
    const path = `/auth/confirm?token_hash=${target.token_hash}&type=invite`,
      p = await rep.get(path);
    const r = await submit(rep, path, p.html, () => true);
    assert.equal(r.location, "/auth/reset-password");
    const reset = await rep.get("/auth/reset-password");
    assert.match(reset.html, /New password/);
    const done = await submit(
      rep,
      "/auth/reset-password",
      reset.html,
      () => true,
      { password, confirm: password },
    );
    assert.equal(done.location, "/login?password=updated");
    const replay = await anon.get(path);
    const again = await submit(anon, path, replay.html, () => true);
    assert.match(again.html, /expired or has already been used/);
  },
);
await check(
  "sales login succeeds and administrator route/actions are denied",
  async () => {
    assert.equal((await login(rep, email, password)).status, 303);
    const home = await rep.get("/");
    assert.match(home.html, /Sarah/);
    assert.ok(!home.html.includes('href="/settings/users"'));
    assert.equal((await rep.get("/settings/users")).location, "/forbidden");
    const p = await admin.get("/settings/users");
    const denied = await submit(
      rep,
      "/settings/users",
      p.html,
      (f) => f.includes("Send invitation"),
      {
        first_name: "Bad",
        last_name: "Actor",
        email: "bad@example.test",
        mobile: "",
        role: "administrator",
        active: "true",
      },
    );
    assert.equal(denied.location, "/forbidden");
  },
);
await check("logout clears active session and returns to login", async () => {
  const p = await rep.get("/");
  const r = await submit(rep, "/", p.html, (f) => f.includes("Log Out"));
  assert.equal(r.location, "/login");
  assert.equal((await rep.get("/")).location, "/login");
});
await fetch(fixture + "/__advance-email-limit");
await check(
  "forgot password uses the same public response for known and unknown emails",
  async () => {
    const p = await rep.get("/forgot-password");
    for (const address of [email, "unknown@example.test"]) {
      const r = await submit(rep, "/forgot-password", p.html, () => true, {
        email: address,
      });
      assert.match(r.html, /If this address is eligible/);
    }
  },
);
const nextPassword = "Updated-fixture-password-456!";
await check(
  "recovery email grants reset; old password rejected and new password works",
  async () => {
    const mail = await (await fetch(fixture + "/__mail")).json(),
      m = mail.findLast((m) => m.email === email && m.type === "recovery");
    assert.ok(m);
    const path = `/auth/confirm?token_hash=${m.token_hash}&type=recovery`,
      p = await rep.get(path);
    assert.equal(
      (await submit(rep, path, p.html, () => true)).location,
      "/auth/reset-password",
    );
    const reset = await rep.get("/auth/reset-password");
    assert.equal(
      (
        await submit(rep, "/auth/reset-password", reset.html, () => true, {
          password: nextPassword,
          confirm: nextPassword,
        })
      ).location,
      "/login?password=updated",
    );
    assert.match((await login(rep, email, password)).html, /Unable to sign in/);
    assert.equal((await login(rep, email, nextPassword)).status, 303);
  },
);
await check(
  "change password requires current password and logs out after success",
  async () => {
    const p = await rep.get("/settings/security");
    const bad = await submit(
      rep,
      "/settings/security",
      p.html,
      (f) => f.includes("Save password"),
      { current_password: "wrong", password, confirm: password },
    );
    assert.match(bad.html, /current password could not be verified/);
    const good = await submit(
      rep,
      "/settings/security",
      p.html,
      (f) => f.includes("Save password"),
      { current_password: nextPassword, password, confirm: password },
    );
    assert.equal(good.location, "/login?password=updated");
    assert.equal((await login(rep, email, password)).status, 303);
  },
);
await check(
  "administrator deactivates staff; existing session and new logins denied",
  async () => {
    const p = await admin.get("/settings/users");
    const r = await submit(
      admin,
      "/settings/users",
      p.html,
      (f) => f.includes(`value="${target.user_id}"`) && f.includes("Save user"),
      {
        id: target.user_id,
        first_name: "Sarah",
        last_name: "Jones",
        email,
        mobile: "07700900123",
        role: "sales",
        active: "false",
      },
    );
    assert.match(r.html, /Staff account updated/);
    assert.equal((await rep.get("/")).location, "/login");
    assert.match((await login(rep, email, password)).html, /Unable to sign in/);
  },
);
await check(
  "administrator reactivates and changes roles, then triggers reset email",
  async () => {
    const p = await admin.get("/settings/users");
    const r = await submit(
      admin,
      "/settings/users",
      p.html,
      (f) => f.includes(`value="${target.user_id}"`) && f.includes("Save user"),
      {
        id: target.user_id,
        first_name: "Sarah",
        last_name: "Jones",
        email,
        mobile: "07700900123",
        role: "finance",
        active: "true",
      },
    );
    assert.match(r.html, /Staff account updated/);
    assert.equal((await login(rep, email, password)).location, "/orders");
    await fetch(fixture + "/__advance-email-limit");
    const p2 = await admin.get("/settings/users");
    const r2 = await submit(
      admin,
      "/settings/users",
      p2.html,
      (f) =>
        f.includes(`value="${target.user_id}"`) &&
        f.includes("Send password reset"),
    );
    assert.match(r2.html, /Email requested successfully/);
  },
);
await check(
  "audit records retain account history without passwords or reset tokens",
  async () => {
    const history = await (await fetch(fixture + "/__history")).json(),
      own = history.filter((h) => h.entity_id === target.user_id);
    assert.ok(own.some((h) => h.action === "USER_CREATED"));
    assert.ok(own.some((h) => h.action === "INVITATION_SENT"));
    assert.ok(own.some((h) => h.action === "LOGIN"));
    assert.ok(own.some((h) => h.action === "PASSWORD_CHANGED"));
    assert.ok(
      own.some(
        (h) =>
          h.new_value?.active === false && h.previous_value?.active === true,
      ),
    );
    const text = JSON.stringify(history);
    assert.ok(
      !text.includes(password) &&
        !text.includes(nextPassword) &&
        !text.includes(target.token_hash),
    );
  },
);
await check(
  "administrator changes own password through Settings Security and signs in again",
  async () => {
    const changed = "Fixture-admin-changed-123!";
    for (const [current, next] of [
      [password, changed],
      [changed, password],
    ]) {
      const p = await admin.get("/settings/security");
      const result = await submit(
        admin,
        "/settings/security",
        p.html,
        (f) => f.includes("Save password"),
        {
          current_password: current,
          password: next,
          confirm: next,
        },
      );
      assert.equal(result.location, "/login?password=updated");
      assert.match(
        (await login(admin, "admin@example.test", current)).html,
        /Unable to sign in/,
      );
      assert.equal(
        (await login(admin, "admin@example.test", next)).status,
        303,
      );
    }
  },
);
console.log(
  `${checks} full application Auth HTTP checks passed (synthetic email delivery)`,
);
