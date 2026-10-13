import type { Order, SavedPayment } from "../orders/model";
export type Refund = {
  id: string;
  payment_id: string;
  amount: number;
  refund_date: string;
  reason: string;
  reference: string;
  notes: string;
  authorised_by: string;
};
export type Charge = {
  id: string;
  category: string;
  description: string;
  amount: number;
  vat_rate: number;
  vat_amount: number;
  total: number;
};
export type FinanceRecord = {
  required: boolean;
  provider: string;
  amount_financed: number;
  customer_deposit: number;
  application_date: string | null;
  reference: string;
  status: string;
  approval_date: string | null;
  notes: string;
};
export type FinancialSummary = {
  order: Order;
  product_value: number;
  accessories: number;
  lights:number;
  prescription_charges: number;
  other_charges: number;
  net: number;
  payments: SavedPayment[];
  refunds: Refund[];
  charges: Charge[];
  finance: FinanceRecord | null;
};
export type PaymentResult = SavedPayment & {
  customer_name: string;
  order_number: number;
  received_name: string;
  total_count: number;
};
