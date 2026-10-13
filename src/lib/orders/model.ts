import type { OrderStatus, Category } from "./hub";
import { z } from "zod";
import { minor, displayed, percentOf } from "@/lib/finance/money";
import { validWorkingDistance } from "./working-distance";
export const money = z
  .number()
  .finite()
  .min(0)
  .max(1000000)
  .refine(
    (n) => /^\d+(\.\d{1,2})?$/.test(String(n)),
    "Use at most two decimal places",
  );
const numberOrNull = (min: number, max: number) =>
  z.number().finite().min(min).max(max).nullable();
export const eyeSchema = z.object({
  sphere: numberOrNull(-30, 30),
  cylinder: numberOrNull(-30, 30),
  axis: z.number().int().min(0).max(180).nullable(),
  add: numberOrNull(0, 20),
  prism: numberOrNull(0, 20),
});
export const configurationSchema = z.object({
  magnification: z.string().max(100),
  frame: z.string().max(100),
  frame_colour: z.string().max(100),
  working_distance: z.union([
    z.literal(""),
    z.number().int().min(350).max(550),
    z.string().regex(/^\d+$/).transform(Number).refine(validWorkingDistance),
  ]),
  manufacturer_instructions: z.string().max(10000),
});
export const itemSchema = z.object({
  id: z.uuid(),
  product_id: z.uuid(),
  quantity: z.number().int().min(1).max(100),
  unit_price: money,
  discount_type: z.enum(["none", "fixed", "percent"]),
  discount_value: money,
  discount_reason: z.string().max(1000),
  vat_applicable: z.boolean().optional(),
  vat_rate: z
    .number()
    .finite()
    .min(0)
    .max(100)
    .refine((n) => /^\d+(\.\d{1,2})?$/.test(String(n))),
  configuration: configurationSchema,
});
export const paymentMethods = [
  "Card",
  "Bank Transfer",
  "Cash",
  "Payment Link",
  "Finance",
  "Other",
] as const;
export const paymentSchema = z.object({
  id: z.uuid(),
  status: z
    .enum(["Pending", "Completed", "Failed", "Partially Refunded", "Refunded"])
    .optional(),
  payment_date: z.iso.date(),
  amount: money.refine((n) => n > 0, "Payment must be positive"),
  method: z.enum(paymentMethods),
  reference: z.string().max(200),
  notes: z.string().max(1000),
});
export const orderDraftSchema = z.object({
  customer_id: z.uuid(),
  current_step: z.number().int().min(1).max(7),
  measurements: z.object({
    right_bd: numberOrNull(0.01, 100),
    left_bd: numberOrNull(0.01, 100),
    working_distance: z.number().int().min(350).max(550).nullable(),
    notes: z.string().max(10000),
  }),
  prescription: z.object({
    required: z.boolean(),
    right_eye: eyeSchema,
    left_eye: eyeSchema,
    prescription_date: z.union([z.literal(""), z.iso.date()]),
    provider: z.string().max(200),
    notes: z.string().max(10000),
  }),
  items: z.array(itemSchema).max(50),
  payments: z.array(paymentSchema).max(50),
});
export type Draft = z.infer<typeof orderDraftSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Eye = z.infer<typeof eyeSchema>;
export type Product = {
  system_code?:string;
  manufacturer_name?: string;
  manufacturer_model?: string;
  elevate_product_name?: string;
  elevate_product_family?: string;
  display_name?: string;
  description?: string;
  default_price?: number | null;
  id: string;
  sku: string;
  name: string;
  kind: "Loupe" | "Light" | "Battery" | "Charger" | "Accessory";
  default_vat_rate?: number;
  default_vat_applicable?: boolean;
  options: Record<string, string[]>;
  active: boolean;
  provisional: boolean;
  created_at: string;
};
export type Order = {
  id: string;
  order_number: number;
  customer_id: string;
  status: OrderStatus;
  manufacturer_reference: string;
  expected_completion_date: string | null;
  order_date?:string|null;
  manufacturing_expected_from?:string|null;
  manufacturing_expected_to?:string|null;
  manufacturing_override_reason?:string;
  current_step: number;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  subtotal: number;
  discount_total: number;
  vat_total: number;
  total: number;
  amount_paid: number;
  balance: number;
  refunds_total: number;
  net_received: number;
  payment_status: string;
  deposit_type: "none" | "fixed" | "percent";
  deposit_value: number;
  required_deposit: number;
  deposit_received: number;
  deposit_outstanding: number;
  deposit_satisfied: boolean;
};
export type Measurement = Draft["measurements"] & {
  order_id: string;
  total_bd: number | null;
  measurement_date: string | null;
  measured_by: string | null;
  right_pupil_height?: number | null;
  left_pupil_height?: number | null;
  scan_fit_session_id?: string | null;
};
export type Prescription = Draft["prescription"] & { order_id: string };
export type SavedItem = Item & {
  product_identity?: Record<string,string>;
  order_id: string;
  sku: string;
  description: string;
  kind: Product["kind"];
  authorised_by: string | null;
  discounted_at: string | null;
  subtotal: number;
  discount_amount: number;
  vat_amount: number;
  total: number;
};
export type SavedPayment = Payment & {
  order_id: string;
  received_by: string;
  created_at: string;
  customer_id: string;
  paid_at: string;
  created_by: string;
};
export type OrderFile = {
  registry?: boolean;
  id: string;
  order_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  category: Category;
  storage_bucket: "order-prescriptions" | "order-attachments" | "crm-media";
  uploaded_by: string;
  created_at: string;
};
export const blankEye = (): Eye => ({
  sphere: null,
  cylinder: null,
  axis: null,
  add: null,
  prism: null,
});
export const blankConfiguration = () => ({
  magnification: "",
  frame: "",
  frame_colour: "",
  working_distance: "" as number | "",
  manufacturer_instructions: "",
});
export const emptyDraft = (customerId = ""): Draft => ({
  customer_id: customerId,
  current_step: 1,
  measurements: {
    right_bd: null,
    left_bd: null,
    working_distance: null,
    notes: "",
  },
  prescription: {
    required: false,
    right_eye: blankEye(),
    left_eye: blankEye(),
    prescription_date: "",
    provider: "",
    notes: "",
  },
  items: [],
  payments: [],
});
export function lineTotals(item: Item) {
  const subtotal = minor(item.unit_price) * BigInt(item.quantity);
  const discount =
    item.discount_type === "fixed"
      ? minor(item.discount_value)
      : item.discount_type === "percent"
        ? percentOf(subtotal, minor(item.discount_value))
        : 0n;
  const vat =
    item.vat_applicable === false
      ? 0n
      : percentOf(subtotal - discount, minor(item.vat_rate));
  return {
    subtotal: displayed(subtotal),
    discount: displayed(discount),
    vat: displayed(vat),
    total: displayed(subtotal - discount + vat),
  };
}
export function totals(draft: Pick<Draft, "items" | "payments">) {
  const lines = draft.items.map(lineTotals);
  const sum = (key: keyof ReturnType<typeof lineTotals>) =>
    lines.reduce((n, l) => n + minor(l[key]), 0n);
  const paid = draft.payments
    .filter(
      (p) =>
        !p.status ||
        ["Completed", "Partially Refunded", "Refunded"].includes(p.status),
    )
    .reduce((n, p) => n + minor(p.amount), 0n);
  return {
    subtotal: displayed(sum("subtotal")),
    discount: displayed(sum("discount")),
    vat: displayed(sum("vat")),
    total: displayed(sum("total")),
    paid: displayed(paid),
    balance: displayed(sum("total") - paid),
  };
}
export function validateDraft(
  draft: Draft,
  products: Product[],
  confirm = false,
): string | null {
  const result = orderDraftSchema.safeParse(draft);
  if (!result.success)
    return result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
  if (new Set(draft.items.map((i) => i.product_id)).size !== draft.items.length)
    return "Combine quantities instead of adding the same product twice.";
  for (const item of draft.items) {
    const product = products.find((p) => p.id === item.product_id && p.active);
    if (!product) return "One of your products is no longer available.";
    const t = lineTotals(item);
    if (
      t.discount > t.subtotal ||
      (item.discount_type === "percent" && item.discount_value > 100)
    )
      return "Discount cannot exceed the line value.";
    if (t.discount > 0 && !item.discount_reason.trim())
      return "Enter a reason for every discount.";
    if (product.kind === "Loupe") {
      for (const key of [
        "magnification",
        "frame",
        "frame_colour",
        "working_distance",
      ] as const) {
        const value = item.configuration[key];
        if (
          key !== "working_distance" &&
          value &&
          !product.options[key]?.includes(String(value))
        )
          return `Choose a valid ${key.replaceAll("_", " ")}.`;
        if (confirm && !value)
          return "Complete all loupe configuration options.";
      }
    }
    if (confirm && item.unit_price <= 0)
      return "Enter a verified price for every item.";
  }
  if (totals(draft).balance < 0)
    return "Payments cannot exceed the order total.";
  if (confirm) {
    if (
      !draft.measurements.right_bd ||
      !draft.measurements.left_bd ||
      !draft.measurements.working_distance
    )
      return "Complete right BD, left BD and working distance.";
    if (
      draft.items.filter(
        (i) => products.find((p) => p.id === i.product_id)?.kind === "Loupe",
      ).length !== 1
    )
      return "Select one loupe model.";
  }
  return null;
}
export const currency = (amount: number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    amount,
  );
export const orderNumber = (n: number) => `EO-${n}`;
export function hydrateDraft(
  order: Order,
  m: Measurement | null,
  rx: Prescription | null,
  items: SavedItem[],
  payments: SavedPayment[],
): Draft {
  const blank = emptyDraft(order.customer_id);
  return {
    ...blank,
    current_step: order.current_step,
    measurements: m
      ? {
          right_bd: m.right_bd,
          left_bd: m.left_bd,
          working_distance: m.working_distance,
          notes: m.notes,
        }
      : blank.measurements,
    prescription: rx
      ? {
          ...rx,
          right_eye: { ...blankEye(), ...rx.right_eye },
          left_eye: { ...blankEye(), ...rx.left_eye },
          prescription_date: rx.prescription_date ?? "",
        }
      : blank.prescription,
    items: items.map((i) => ({
      ...i,
      configuration: { ...blankConfiguration(), ...i.configuration },
    })),
    payments,
  };
}
