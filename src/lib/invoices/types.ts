export type Company = {
  legal_name: string;
  trading_name: string;
  address: string;
  company_number: string;
  registration_country: string;
  vat_registered: boolean | null;
  vat_number: string;
  email: string;
  telephone: string;
  website: string;
  logo_path: string;
  payment_details: string;
  payment_terms: string;
  footer: string;
  currency: string;
  invoice_prefix: string;
  default_vat_rate: string;
  default_vat_applicable: boolean;
};
export type InvoiceLine = {
  id: string;
  description: string;
  sku: string;
  kind: string;
  quantity: number;
  unit_price: string;
  subtotal: string;
  discount: string;
  net: string;
  vat_applicable: boolean;
  vat_rate: string;
  vat: string;
  total: string;
};
export type InvoiceSnapshot = {
  order_id: string;
  order_number: number;
  order_version: number;
  customer_id: string;
  customer_name: string;
  practice: string;
  billing_address: Record<string, string> | null;
  company: Company;
  company_verified: boolean;
  company_version: string;
  invoice_date: string;
  supply_date: string;
  due_date: string | null;
  currency: string;
  lines: InvoiceLine[];
  subtotal: string;
  discount: string;
  net: string;
  vat: string;
  total: string;
  payments: string;
  refunds: string;
  net_received: string;
  balance: string;
  notes: string;
};
export type Invoice = {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string;
  invoice_date: string;
  supply_date: string;
  due_date: string | null;
  status: string;
  currency: string;
  subtotal_net: number;
  discount_total: number;
  vat_total: number;
  gross_total: number;
  amount_paid: number;
  amount_due: number;
  snapshot: InvoiceSnapshot;
  created_by: string;
  created_at: string;
  issued_at: string | null;
  pdf_storage_path: string | null;
  pdf_sha256: string | null;
  notes: string;
  replaces_invoice_id: string | null;
  cancel_reason: string;
};
export type CompanySettings = {
  id: boolean;
  details: Company;
  verified_by: string | null;
  verified_at: string | null;
  updated_at: string;
};
export const addressText = (a: Record<string, string> | null | undefined) =>
  a
    ? [a.line1, a.line2, a.city, a.county, a.postcode, a.country]
        .filter(Boolean)
        .join("\n")
    : "";
