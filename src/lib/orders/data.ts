import "server-only";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { type OrderFile, hydrateDraft } from "./model";
export async function loadOrder(id: string) {
  if (!z.uuid().safeParse(id).success) notFound();
  const { db } = await requireStaff();
  const orderResult = await db
    .from("orders")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (orderResult.error) throw new Error("Unable to load order");
  if (!orderResult.data) notFound();
  const order = orderResult.data;
  const [customer, measurement, prescription, items, payments, files, links] =
    await Promise.all([
      db.from("customers").select("*").eq("id", order.customer_id).single(),
      db.from("measurements").select("*").eq("order_id", id).maybeSingle(),
      db.from("prescriptions").select("*").eq("order_id", id).maybeSingle(),
      db.from("order_items").select("*").eq("order_id", id).order("kind"),
      db.from("payments").select("*").eq("order_id", id).order("payment_date"),
      db
        .from("media_files")
        .select("*")
        .eq("order_id", id)
        .eq("status", "Active")
        .order("created_at")
        .limit(1000),
      db.from("media_order_links").select("file_id").eq("order_id", id),
    ]);
  if (
    [customer, measurement, prescription, items, payments, files, links].some(
      (r) => r.error,
    )
  )
    throw new Error("Unable to load complete order");
  const linkedIds = (links.data ?? [])
    .map((l) => l.file_id)
    .filter((fileId) => !files.data?.some((f) => f.id === fileId));
  const linked = linkedIds.length
    ? await db
        .from("media_files")
        .select("*")
        .in("id", linkedIds)
        .eq("status", "Active")
    : { data: [], error: null };
  if (linked.error) throw new Error("Unable to load linked order files");
  const orderFiles: OrderFile[] = [
    ...(files.data ?? []),
    ...(linked.data ?? []),
  ].map((f) => ({
    id: f.id,
    order_id: id,
    filename: f.filename,
    mime_type: f.mime_type,
    size_bytes: f.size_bytes,
    storage_path: "",
    storage_bucket: "crm-media",
    category: (f.category === "Measurement"
      ? "Measurements"
      : f.category) as OrderFile["category"],
    registry: f.source !== "Order legacy",
    uploaded_by: f.uploaded_by,
    created_at: f.created_at,
  }));
  items.data!.sort(
    (a, b) =>
      (a.kind === "Loupe" ? 0 : a.kind === "Light" ? 1 : 2) -
      (b.kind === "Loupe" ? 0 : b.kind === "Light" ? 1 : 2),
  );
  return {
    order,
    measurement: measurement.data,
    prescription: prescription.data,
    customer: customer.data!,
    draft: hydrateDraft(
      order,
      measurement.data,
      prescription.data,
      items.data!,
      payments.data!,
    ),
    files: orderFiles,
    items: items.data!,
    payments: payments.data!,
  };
}
export async function catalogue() {
  const { db } = await requireStaff();
  const { data, error } = await db
    .from("products")
    .select("*")
    .eq("active", true)
    .order("sku");
  if (error)
    throw new Error("Catalogue unavailable. Apply the Phase 3 migration.");
  const company = await db.from("company_settings").select("*").maybeSingle();
  if (company.error)
    throw new Error(
      "Company VAT defaults unavailable. Apply the Phase 5.1 migrations.",
    );
  const settings = company.data;
  if (!settings?.verified_at) return data;
  // Only newly added lines receive these defaults; saved lines keep their recorded tax treatment.
  return data.map((product) => ({
    ...product,
    default_vat_applicable:
      settings.details.vat_registered === true &&
      product.default_vat_applicable,
    default_vat_rate:
      settings.details.vat_registered === true
        ? product.default_vat_rate
        : 0,
  }));
}
