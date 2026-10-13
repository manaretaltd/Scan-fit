import { z } from "zod";
export const lifecycle = [
  "Order Confirmed",
  "Ready for Manufacturer",
  "Submitted to Manufacturer",
  "In Production",
  "QC",
  "Shipped to UK",
  "Received in UK",
  "Customer Delivery",
  "Fitting",
  "Aftercare",
  "Closed",
] as const;
export const categories = [
  "Measurements",
  "Prescription",
  "Manufacturer",
  "Finance",
  "Shipping",
  "Delivery",
  "Aftercare",
  "Warranty",
  "Other",
] as const;
export type Category = (typeof categories)[number];
export type OrderStatus = "Draft" | (typeof lifecycle)[number];
export type OrderEvent = {
  media_file_id?: string | null;
  id: string;
  order_id: string;
  kind: string;
  description: string;
  audience: string;
  user_id: string | null;
  created_at: string;
};
export type StatusChange = {
  id: string;
  order_id: string;
  from_status: string | null;
  to_status: string;
  reason: string;
  user_id: string | null;
  created_at: string;
};
export type Aftercare = {
  order_id: string;
  delivery_confirmed: boolean;
  fitting_date: string | null;
  fitting_completed: boolean;
  fit_satisfactory: boolean | null;
  adjustment_required: boolean;
  adjustment_notes: string;
  return_to_manufacturer: boolean;
  warranty_case: boolean;
  warranty_status: string;
  resolution_date: string | null;
  updated_by: string | null;
  updated_at: string;
};
export type ManufacturerSnapshot = {
  order_number: number;
  order_date?: string;
  sales_representative?: string;
  attachments?: {
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
  }[];
  manufacturer_reference: string;
  expected_completion_date: string | null;
  customer: { name: string; practice: string };
  measurements: Record<string, unknown> | null;
  prescription: Record<string, unknown> | null;
  items: {
      manufacturer_model?:string;manufacturer_name?:string;commercial_name?:string;
    sku: string;
    description: string;
    kind: string;
    quantity: number;
    configuration: Record<string, string>;
  }[];
};
export type ManufacturerPack = {
  version?: number;
  generated_file_id?: string | null;
  review_fingerprint?: string;
  id: string;
  order_id: string;
  prepared_by: string;
  created_at: string;
  instructions: string;
  file_ids: string[];
  snapshot: ManufacturerSnapshot;
};
const text = z.string().trim().max(10000),
  date = z.union([z.literal(""), z.iso.date()]);
export const operations = {
  payment: z.object({
    amount: z.coerce
      .number()
      .positive()
      .max(1000000)
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-7),
    payment_date: z.iso.date(),
    method: z.enum([
      "Card",
      "Bank Transfer",
      "Cash",
      "Payment Link",
      "Finance",
      "Other",
    ]),
    reference: text,
    notes: text,
  }),
  note: z.object({ note: text.min(1) }),
  status: z.object({
    status: z.enum(lifecycle),
    expected_status: z.enum(lifecycle),
    reason: text.min(1),
  }),
  followup: z.object({
    title: text.min(1).max(200),
    description: text,
    assigned_to: z.uuid(),
    due_date: z.iso.date(),
    priority: z.enum(["Low", "Medium", "High"]),
  }),
  complete: z.object({ task_id: z.uuid(), completed: z.boolean() }),
  details: z.object({
    manufacturer_reference: text.max(200),
    expected_completion_date: date.optional(),
  }),
  measurement: z.object({
    measurement_date: date,
    measured_by: z.union([z.literal(""), z.uuid()]),
  }),
  aftercare: z.object({
    delivery_confirmed: z.boolean(),
    fitting_date: date,
    fitting_completed: z.boolean(),
    fit_satisfactory: z.enum(["", "true", "false"]),
    adjustment_required: z.boolean(),
    adjustment_notes: text,
    return_to_manufacturer: z.boolean(),
    warranty_case: z.boolean(),
    warranty_status: z.enum([
      "Not opened",
      "Open",
      "In review",
      "Resolved",
      "Declined",
    ]),
    resolution_date: date,
  }),
  manufacturer: z.object({
    instructions: text,
    file_ids: z.array(z.uuid()).max(30),
  }),
};
export type Operation = keyof typeof operations;
export function fileMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    return "image/png";
  const ascii = (a: number, b: number) =>
    String.fromCharCode(...bytes.slice(a, b));
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (
    ascii(4, 8) === "ftyp" &&
    ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "].includes(ascii(8, 12))
  )
    return "video/mp4";
  if (
    [0x1a, 0x45, 0xdf, 0xa3].every((b, i) => bytes[i] === b) &&
    ascii(0, 128).includes("webm")
  )
    return "video/webm";
  return null;
}
