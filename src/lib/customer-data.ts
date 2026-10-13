import { notFound } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "./auth";
export async function customerData(id: string) {
  if (!z.uuid().safeParse(id).success) notFound();
  const { db } = await requirePermission("customers.read");
  const result = await db
    .from("customers")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (result.error) throw new Error("Customer could not be loaded");
  if (!result.data) notFound();
  return { db, customer: result.data };
}
export async function customerOptions() {
  const { db } = await requirePermission("customers.read");
  const [staff, sources] = await Promise.all([
    db
      .from("users")
      .select("*")
      .in("role", ["sales", "administrator"])
      .order("full_name"),
    db.from("lead_sources").select("name").eq("active", true).order("name"),
  ]);
  if (staff.error || sources.error)
    throw new Error("Customer options could not be loaded");
  return { staff: staff.data, sources: sources.data.map((s) => s.name) };
}
