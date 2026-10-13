import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { authAdmin } from "@/lib/supabase/admin";
import { aggregate, analyse } from "@/lib/scan-fit/geometry";
import { observationSchema, type ScanSession } from "@/lib/scan-fit/model";
import { scanImages } from "@/lib/scan-fit/images";
import { cleanupUnregistered } from "@/lib/scan-fit/server";
import type { Json } from "@/lib/types";
export const runtime = "nodejs";
const id = z.string().uuid();
function sameOrigin(request: Request) {
  return request.headers.get("origin") === new URL(process.env.APP_URL || request.url).origin;
}
function linkHash(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw Error("Measurement link unavailable");
  return createHash("sha256").update(token).digest("hex");
}
async function authorize(hash: string) {
  const { data, error } = await authAdmin().rpc("scan_fit_client_authorize", { link_hash: hash, operation: "status", payload: {} });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) throw Error("Measurement link unavailable");
  return data as { state: "ready" | "submitted"; session: ScanSession; expires_at?: string };
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const data = await authorize(linkHash(request));
    if (data.state === "submitted") return Response.json({ state: "submitted" }, { headers: { "Cache-Control": "private, no-store" } });
    const s = data.session;
    // No customer identity, issuer, order, image or database credentials are sent to clients.
    const session: ScanSession = {
      id: s.id, customer_id: "", order_id: null, operator_id: "", status: "Started",
      profile_snapshot: s.profile_snapshot, config_snapshot: s.config_snapshot,
      device_info: {}, validation_mode: false, created_at: "", accepted_at: null, accepted_by: null,
    };
    return Response.json({ state: "ready", session }, { headers: { "Cache-Control": "private, no-store" } });
  } catch { return Response.json({ error: "Measurement link unavailable." }, { status: 404, headers: { "Cache-Control": "private, no-store" } }); }
}

async function boundedBody(request: Request, maximum: number) {
  const reader = request.body?.getReader();
  if (!reader) throw Error("Request body is required.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw Error("Request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function PUT(request: Request) {
  if (!sameOrigin(request))
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const uploaded: string[] = [];
  let cleanupSession = "";
  try {
    const clientHash = linkHash(request);
    const authorized = await authorize(clientHash);
    if (authorized.state === "submitted") return Response.json({ submitted: true }, { headers: { "Cache-Control": "private, no-store" } });
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 55_000_000) throw Error("Burst upload is too large.");
    const body = await boundedBody(request, 55_000_000);
    const form = await new Response(new Uint8Array(body), {
        headers: { "Content-Type": request.headers.get("content-type") || "" },
      }).formData(),
      sessionId = id.parse(form.get("session_id")),
      current = { session: authorized.session as ScanSession };
    if (sessionId !== current.session.id) throw Error("Invalid session.");
    if (form.get("consent") !== "true" || form.get("consent_version") !== "remote-capture/1") throw Error("Consent is required.");
    cleanupSession = sessionId;
    if (current.session.status !== "Started")
      throw Error("This session already has captures.");
    const observations = z
      .array(observationSchema)
      .length(5)
      .parse(JSON.parse(String(form.get("observations"))));
    const times = observations.map((o) => Date.parse(o.capturedAt));
    if (
      times.some((t, i) => i > 0 && t <= times[i - 1]) ||
      times[4] - times[0] < 800 ||
      times[4] - times[0] > 10_000
    )
      throw Error(
        "Capture five distinct frames over approximately one to two seconds.",
      );
    const frames = [],
      hashes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const file = form.get(`image_${i}`);
      if (!(file instanceof File) || file.size < 100 || file.size > 10_485_760)
        throw Error("Each burst image must be a JPEG or PNG under 10 MB.");
      const bytes = Buffer.from(await file.arrayBuffer()),
        hash = createHash("sha256").update(bytes).digest("hex");
      if (hashes.has(hash))
        throw Error("Repeated copies of a single image are not a burst.");
      hashes.add(hash);
      const analysis = analyse(
        observations[i],
        current.session.profile_snapshot,
        current.session.config_snapshot,
      );
      const images = await scanImages(
          bytes,
          analysis,
          current.session.profile_snapshot,
        ),
        prefix = `${current.session.customer_id}/${sessionId}/${randomUUID()}`;
      const paths = {
        original_path:
          prefix +
          (images.originalMime === "image/png"
            ? "-original.png"
            : "-original.jpg"),
        annotated_path: prefix + "-annotated.jpg",
        rectified_path: prefix + "-rectified.jpg",
      };
      for (const [key, path] of Object.entries(paths)) {
        const kind = key.replace("_path", "") as
          "original" | "annotated" | "rectified";
        const { error } = await authAdmin()
          .storage.from("scan-fit")
          .upload(path, images[kind], {
            contentType:
              kind === "original" ? images.originalMime : "image/jpeg",
            upsert: false,
          });
        if (error) throw Error("Image upload failed. Please retry.");
        uploaded.push(path);
      }
      frames.push({
        frame_index: i,
        observation: observations[i],
        analysis,
        ...paths,
        image_sha256: hash,
      });
    }
    let result = null;
    let rejection: string | null = null;
    try {
      result = aggregate(
        frames.map((f) => f.analysis),
        current.session.config_snapshot,
      );
    } catch (error) {
      rejection = error instanceof Error ? error.message : "Repeat scan.";
    }
    const { error: submitError } = await authAdmin().rpc("scan_fit_client_authorize", {
      link_hash: clientHash, operation: "submit", payload: {
      consent: true, consent_version: "remote-capture/1",
      session_id: sessionId,
      frames,
      result,
    } as Json });
    if (submitError) throw Error("Submission could not be confirmed.");
    await cleanupUnregistered(sessionId, uploaded);
    return Response.json(
      { submitted: true, needsReview: true, repeatMayBeRequired: rejection !== null },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    if (uploaded.length) await cleanupUnregistered(cleanupSession, uploaded);
    return Response.json(
      {
        error:
          "Your scan could not be submitted. Check the link, connection and capture instructions, then retry.",
      },
      { status: 400 },
    );
  }
}
