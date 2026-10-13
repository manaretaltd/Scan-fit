// Local synthetic preview only. Data resets when this process exits.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const env = {
  ...process.env,
  FIXTURE_PORT: "54332",
  PHASE5_DEMO: "1",
  NEXT_DIST_DIR: ".next-phase51-production",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54332",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "auth-fixture-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "auth-fixture-service-key",
  APP_URL: "http://127.0.0.1:3003",
};
const children = new Set();
function run(args) {
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
function stop() {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
const fixture = run(["--import", "tsx", "tests/auth-fixture.mjs"]);
fixture.on("exit", (code) => {
  if (code) {
    stop();
    process.exit(code);
  }
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      ready = (await fetch(env.NEXT_PUBLIC_SUPABASE_URL + "/health")).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready)
    throw new Error("Synthetic backend did not start. Check port 54332.");
  const build = run(["node_modules/next/dist/bin/next", "build"]);
  const code = await new Promise((resolve) => build.on("exit", resolve));
  if (code !== 0) throw new Error("Preview build failed.");
  console.log(
    "Synthetic Phase 5.1 demo: http://127.0.0.1:3003 · admin@example.test · Fixture-password-123!",
  );
  const app = run([
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3003",
  ]);
  app.on("exit", (code) => {
    stop();
    process.exit(code ?? 1);
  });
} catch (error) {
  console.error(error.message);
  stop();
  process.exit(1);
}
