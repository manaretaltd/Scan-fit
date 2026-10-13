import { z } from "zod";
import { minor } from "./money";
import { paymentMethods } from "../orders/model";
const safeMinor = (value: string) => {
  try {
    return minor(value);
  } catch {
    return -1n;
  }
};
const amount = z
  .string()
  .regex(/^\d{1,7}(\.\d{1,2})?$/)
  .refine(
    (v) => safeMinor(v) >= 0n && safeMinor(v) <= 100000000n,
    "Maximum £1,000,000",
  );
const positive = amount.refine((v) => safeMinor(v) > 0n);
const text = z.string().max(1000),
  reference = z.string().max(200),
  bool = z.enum(["true", "false"]).transform((v) => v === "true");
export const financeSchemas = {
  payment: z.object({
    amount: positive,
    method: z.enum(paymentMethods),
    payment_date: z.iso.date(),
    paid_at: z.union([z.literal(""), z.iso.datetime()]).optional(),
    status: z.enum(["Pending", "Completed", "Failed"]),
    reference,
    notes: text,
    confirm_overpayment: bool,
  }),
  payment_status: z.object({
    payment_id: z.uuid(),
    status: z.enum(["Completed", "Failed"]),
    confirm_overpayment: bool,
  }),
  refund: z.object({
    payment_id: z.uuid(),
    amount: positive,
    refund_date: z.iso.date(),
    reason: text.min(1),
    reference,
    notes: text,
  }),
  deposit: z.object({
    type: z.enum(["none", "fixed", "percent"]),
    value: amount,
  }),
  discount: z.object({
    item_id: z.uuid(),
    type: z.enum(["none", "fixed", "percent"]),
    value: amount,
    reason: text.min(1),
    vat_rate: amount.refine(
      (v) => safeMinor(v) >= 0n && safeMinor(v) <= 10000n,
    ),
    vat_applicable: bool,
  }),
  charge: z.object({
    category: z.enum(["Prescription", "Other"]),
    description: z.string().min(1).max(200),
    amount: positive,
    vat_rate: amount.refine(
      (v) => safeMinor(v) >= 0n && safeMinor(v) <= 10000n,
    ),
    vat_applicable: bool,
  }),
  finance: z.object({
    required: bool,
    provider: reference,
    amount_financed: amount,
    customer_deposit: amount,
    application_date: z.union([z.literal(""), z.iso.date()]),
    reference,
    status: z.enum([
      "Not Started",
      "Application Sent",
      "Pending",
      "Approved",
      "Declined",
      "Completed",
    ]),
    approval_date: z.union([z.literal(""), z.iso.date()]),
    notes: text,
  }),
};
export type FinanceOperation = keyof typeof financeSchemas;
