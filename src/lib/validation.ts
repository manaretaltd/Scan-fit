import { z } from "zod";
export const statuses = ["Lead", "Prospect", "Customer", "Inactive"] as const;
export const activityTypes = [
  "Call",
  "Email",
  "WhatsApp",
  "SMS",
  "Demo",
  "Meeting",
  "Note",
  "Follow-up",
] as const;
export const roles = [
  "administrator",
  "sales",
  "operations",
  "finance",
] as const;
const text = (max = 200) => z.string().trim().max(max);
export const customerSchema = z.object({
  delivery_address_same_as_customer: z.union([z.boolean(),z.enum(["true","false"]).transform(v=>v==="true")]).default(false),
  first_name: text(100).min(1, "First name is required"),
  last_name: text(100).min(1, "Last name is required"),
  email: z.union([z.literal(""), z.email().max(254)]),
  mobile: text(40),
  alternative_phone: text(40),
  profession: text(),
  job_title: text(),
  gdc_number: text(40),
  practice_name: text(),
  practice_telephone: text(40),
  assigned_to: z.union([z.literal(""), z.uuid()]),
  lead_source: text(100),
  status: z.enum(statuses),
  preferred_contact: z.enum(["Email", "Phone", "SMS", "WhatsApp"]),
  notes: text(10000),
});
export const addressSchema = z.object({
  kind: z.enum(["Practice", "Delivery"]),
  line1: text().min(1),
  line2: text(),
  city: text(100),
  county: text(100).default(""),
  postcode: text(20),
  country: text(100).min(1),
});
export const taskSchema = z.object({
  customer_id: z.uuid(),
  title: text().min(1),
  description: text(10000),
  assigned_to: z.uuid(),
  due_date: z.iso.date(),
  priority: z.enum(["Low", "Medium", "High"]),
});
export const activitySchema = z.object({
  customer_id: z.uuid(),
  type: z.enum(activityTypes),
  description: text(10000).min(1),
});
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export function detectFileType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    return "image/png";
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}
export function pageNumber(value?: string) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100000) : 1;
}
export function customerNumber(n: number) {
  return `ES-${n}`;
}
