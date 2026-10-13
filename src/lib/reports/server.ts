import "server-only";
import { requirePermission } from "@/lib/auth";
import type { Filters, Report } from "./model";
import type { Json } from "@/lib/types";
export async function loadReport(filters: Filters) {
  const { db } = await requirePermission("reports.read");
  const { data, error } = await db.rpc("report_data", {
    filters: filters as Json,
  });
  if (error)
    throw Error(
      "Reports unavailable. Check your permissions and Phase 7 migrations.",
    );
  return data as unknown as Report;
}
