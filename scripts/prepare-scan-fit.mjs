import { cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url),
  target = new URL("public/scan-fit-runtime/", root);
await mkdir(target, { recursive: true });
await cp(
  new URL("node_modules/@mediapipe/tasks-vision/wasm/", root),
  new URL("wasm/", target),
  { recursive: true },
);
if (!process.argv.includes("--runtime-only")) {
  const url =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
  const response = await fetch(url);
  if (!response.ok)
    throw Error(
      `Official MediaPipe model download failed: HTTP ${response.status}. Allow storage.googleapis.com in environment settings.`,
    );
  const expected = response.headers
    .get("x-goog-hash")
    ?.match(/md5=([^,]+)/)?.[1];
  if (!expected)
    throw Error(
      "Official model checksum is unavailable. Refusing an unverified download.",
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("md5").update(bytes).digest("base64") !== expected)
    throw Error("Official model checksum mismatch.");
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
  )
    throw Error(
      "The pinned official model SHA-256 does not match. Review the upstream artifact before using it.",
    );
  const model = new URL("face_landmarker.task", target);
  try {
    const previous = await readFile(model);
    if (
      createHash("sha256").update(previous).digest("hex") !==
      createHash("sha256").update(bytes).digest("hex")
    )
      throw Error(
        "Installed model differs from the pinned official version; review before replacing it.",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(model, bytes);
  await writeFile(
    new URL("model-manifest.json", target),
    JSON.stringify(
      {
        source: url,
        version: "1",
        md5: expected,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Verified and installed MediaPipe model (${bytes.length} bytes).`,
  );
}
console.log(
  `Local MediaPipe WASM runtime prepared at ${fileURLToPath(target)}.`,
);
