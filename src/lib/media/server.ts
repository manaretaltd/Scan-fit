import "server-only";
import { requireStaff } from "@/lib/auth";
import { z } from "zod";
import type { Json } from "@/lib/types";
import type { MediaConfig, MediaResult } from "./types";
export const mediaFilters = z.object({
  customer: z.uuid().optional(),
  order: z.uuid().optional(),
  category: z.string().max(100).optional(),
  uploader: z.uuid().optional(),
  type: z.enum(["image", "video", "application"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  q: z.string().max(100).optional(),
  status: z.enum(["Active", "Archived", "All"]).optional(),
  page: z.coerce.number().int().min(0).max(100000).optional(),
});
export async function mediaConfig() {
  const { db } = await requireStaff();
  const { data, error } = await db.rpc("media_config", {});
  if (error)
    throw Error("File configuration unavailable. Apply Phase 6 migrations.");
  return data as unknown as MediaConfig;
}
export async function searchMedia(filters: Record<string, unknown>) {
  const { db } = await requireStaff();
  const parsed = mediaFilters.parse(filters);
  const { data, error } = await db.rpc("search_media", {
    filters: parsed as Json,
  });
  if (error)
    throw Error(
      "Files are unavailable. Check access or storage configuration.",
    );
  return data as unknown as MediaResult;
}
export function sameOrigin(request: Request) {
  return (
    request.headers.get("origin") ===
    new URL(process.env.APP_URL || request.url).origin
  );
}
