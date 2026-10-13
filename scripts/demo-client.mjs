import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const env = {
  ...process.env,
  FIXTURE_PORT: "54338", PHASE5_DEMO: "1", PHASE6_DEMO: "1", PHASE7_DEMO: "1",
  PHASE_SCAN_FIT_DEMO: "1", PHASE_CLIENT_SCAN_DEMO: "1",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54338",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "auth-fixture-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "auth-fixture-service-key",
  APP_URL: "http://127.0.0.1:3018",
  SCAN_FIT_ALLOW_TEST_ORDER_WRITES: "0",
};
const children = new Set();
function run(args) {
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  children.add(child); child.on("exit", () => children.delete(child)); return child;
}
function stop() { for (const child of children) child.kill("SIGTERM"); }
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stop(); process.exit(0); });
const fixture = run(["--import", "tsx", "tests/auth-fixture.mjs"]);
fixture.on("exit", code => { if (code) { stop(); process.exit(code); } });
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { ready = (await fetch(env.NEXT_PUBLIC_SUPABASE_URL + "/health")).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw Error("Isolated client backend did not start.");
  const build = run(["node_modules/next/dist/bin/next", "build"]);
  const code = await new Promise(resolve => build.on("exit", resolve));
  if (code !== 0) throw Error("Client app build failed.");
  const app = run(["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3018"]);
  app.on("exit", code => { stop(); process.exit(code ?? 1); });
} catch (error) { console.error(error.message); stop(); process.exit(1); }
