import { z } from "zod";
export const productSchema = z.object({
  id: z.uuid(),
  manufacturer_name: z.string().trim().max(180),
  manufacturer_model: z.string().trim().min(1).max(180),
  elevate_product_name: z.string().trim().max(180),
  elevate_product_family: z.string().trim().max(180),
  display_name: z.string().trim().min(1).max(180),
  description: z.string().max(4000),
  sku: z.string().trim().min(1).max(180),
  active: z.boolean(),
  provisional: z.boolean(),
  default_price: z.number().min(0).max(1000000).multipleOf(0.01).nullable(),
  default_vat_rate: z.number().min(0).max(100).multipleOf(0.01),
  default_vat_applicable: z.boolean(),
  options: z.record(
    z.string().max(100),
    z.array(z.string().min(1).max(100)).max(100),
  ),
});
export function commercialName(model: string, name: string) {
  return name.trim()
    ? `${model.trim()} / ELEVATE ${name.trim()}™`
    : model.trim();
}
