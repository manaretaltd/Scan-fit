import "server-only";
import { supabase } from "../supabase/server";
import { authAdmin, authAdminConfigured } from "../supabase/admin";
import type { Json } from "../types";

export async function scanAccess() {
  const db = await supabase();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw Error("Sign in to use Scan Fit.");
  const { data: staff } = await db
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();
  if (!staff?.active || !["administrator", "sales"].includes(staff.role))
    throw Error("Scan Fit is restricted to active clinical staff.");
  return { db, staff };
}
export async function sessionData(id: string) {
  const { db, staff } = await scanAccess();
  const session = await db
    .from("scan_fit_sessions")
    .select("*")
    .eq("id", id)
    .single();
  if (session.error || !session.data)
    throw Error("Scan Fit session is unavailable or access is denied.");
  const [frames, result] = await Promise.all([
    db
      .from("scan_fit_frames")
      .select("*")
      .eq("session_id", id)
      .order("frame_index"),
    db.from("scan_fit_results").select("*").eq("session_id", id).maybeSingle(),
  ]);
  if (frames.error || result.error)
    throw Error("Scan Fit data could not be loaded.");
  return {
    db,
    staff,
    session: session.data,
    frames: frames.data ?? [],
    result: result.data,
  };
}
export async function operate(
  actor: string,
  operation: string,
  payload: unknown,
) {
  if (!authAdminConfigured())
    throw Error(
      "Scan Fit persistence requires the existing server-only Supabase credential and APP_URL.",
    );
  const { data, error } = await authAdmin().rpc("scan_fit_operate", {
    actor,
    operation,
    payload: payload as Json,
  });
  if (error) throw Error(error.message);
  return data as { id: string };
}

// A lost RPC response can follow a committed transaction. Keep every image
// referenced by current frames or correction history during failure recovery.
export async function cleanupUnregistered(sessionId: string, paths: string[]) {
  if (!paths.length || !sessionId) return;
  const admin = authAdmin();
  const [frames, adjustments] = await Promise.all([
    admin
      .from("scan_fit_frames")
      .select("original_path,annotated_path,rectified_path")
      .eq("session_id", sessionId),
    admin
      .from("scan_fit_adjustments")
      .select("previous_correction")
      .eq("session_id", sessionId),
  ]);
  if (frames.error || adjustments.error) return;
  const referenced = new Set<string>();
  for (const frame of frames.data ?? [])
    for (const path of [
      frame.original_path,
      frame.annotated_path,
      frame.rectified_path,
    ])
      referenced.add(path);
  for (const row of adjustments.data ?? []) {
    const previous = row.previous_correction;
    if (
      previous &&
      typeof previous === "object" &&
      !Array.isArray(previous) &&
      typeof previous.annotated_path === "string"
    )
      referenced.add(previous.annotated_path);
  }
  const unregistered = paths.filter((path) => !referenced.has(path));
  if (unregistered.length)
    await admin.storage.from("scan-fit").remove(unregistered);
}
