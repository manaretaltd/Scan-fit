import { z } from "zod";
export const roleLabels = {
  administrator: "Administrator",
  sales: "Sales Representative",
  operations: "Operations",
  finance: "Finance",
} as const;
export const staffSchema = z.object({
  first_name: z.string().trim().min(1).max(70),
  last_name: z.string().trim().min(1).max(70),
  email: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  mobile: z.string().trim().max(40),
  role: z.enum(["administrator", "sales", "operations", "finance"]),
});
export const passwordSchema = z
  .object({ password: z.string().min(12).max(128), confirm: z.string().min(1) })
  .refine((v) => v.password === v.confirm, {
    message: "Passwords must match",
    path: ["confirm"],
  });
export type StaffProfile = {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  mobile: string;
  created_by: string | null;
  last_login: string | null;
  invitation_sent_at: string | null;
};
