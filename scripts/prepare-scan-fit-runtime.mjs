import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Node 24 supports the platform proxy flag; older supported Node versions
// should still prepare the same checksum-pinned model on ordinary hosting.
const flags = process.allowedNodeEnvironmentFlags.has("--use-env-proxy")
  ? ["--use-env-proxy"]
  : [];
const result = spawnSync(
  process.execPath,
  [...flags, fileURLToPath(new URL("./prepare-scan-fit.mjs", import.meta.url)), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
