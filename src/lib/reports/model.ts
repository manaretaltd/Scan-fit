import { z } from "zod";
export const presets = [
  "Today",
  "This Week",
  "This Month",
  "Last Month",
  "This Quarter",
  "This Year",
  "Custom",
] as const;
export const reportFilters = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    preset: z.enum(presets).optional(),
    rep: z.union([z.uuid(), z.literal("")]).optional(),
    product: z.union([z.uuid(), z.literal("")]).optional(),
    family: z.string().max(180).optional(),
    model: z.string().max(180).optional(),
    status: z.string().max(100).optional(),
    lead_source: z.string().max(100).optional(),
    payment_status: z.string().max(100).optional(),
    page: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .refine(
    (f) =>
      f.from <= f.to &&
      Date.parse(f.to) - Date.parse(f.from) <= 3660 * 86400000,
    "Choose a valid date range of at most ten years",
  );
export type Filters = z.infer<typeof reportFilters>;
const iso = (d: Date) => d.toISOString().slice(0, 10);
export function dateRange(
  preset: string,
  now = new Date(),
): { from: string; to: string } {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const date = new Date(day + "T12:00:00Z"),
    y = date.getUTCFullYear(),
    m = date.getUTCMonth();
  let from = date,
    to = date;
  if (preset === "This Week") {
    from = new Date(date);
    from.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  }
  if (preset === "This Month") from = new Date(Date.UTC(y, m, 1, 12));
  if (preset === "Last Month") {
    from = new Date(Date.UTC(y, m - 1, 1, 12));
    to = new Date(Date.UTC(y, m, 0, 12));
  }
  if (preset === "This Quarter")
    from = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1, 12));
  if (preset === "This Year") from = new Date(Date.UTC(y, 0, 1, 12));
  return { from: iso(from), to: iso(to) };
}
export function parseFilters(params: Record<string, string | undefined>) {
  const preset = params.preset || "This Month";
  const dates =
    preset === "Custom"
      ? { from: params.from, to: params.to }
      : dateRange(preset);
  return reportFilters.parse({ ...params, preset, ...dates });
}
export type Row = Record<string, string | number | null>;
export type Report = {
  scope: string;
  from: string;
  to: string;
  as_of: string;
  sales?: Record<string, number>;
  cash?: Record<string, number>;
  financial?: Record<string, number | null>;
  customers?: Record<string, number>;
  wireless?: Record<string, number>;
  products?: Row[];
  representatives?: Row[];
  sources?: Row[];
  months?: Row[];
  pipeline: Row[];
  durations: Record<string, number | null>;
  records: Row[];
  records_total: number;
  cash_records?: Row[];
  cash_records_total?: number;
  invoices?: Row[];
  invoices_total?: number;
};
export const label = (s: string) =>
  s.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
export const gbp = (n: unknown) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    Number(n ?? 0),
  );
export const percentage = (n: number, d: number) =>
  d ? `${((n / d) * 100).toFixed(1)}%` : "Unavailable (no orders)";
export const moneyKeys = new Set([
  "gross_order_value",
  "discounts",
  "net_sales",
  "vat",
  "total_order_value",
  "outstanding",
  "average_order_value",
  "deposits_received",
  "payments_received",
  "refunds",
  "net_receipts",
  "invoice_value",
  "vat_invoiced",
  "invoice_balance",
  "vat_collected",
  "revenue",
  "average_selling_price",
  "sales_value",
  "value",
  "order_value",
  "total",
  "balance",
  "gross_total",
  "amount_due",
  "amount",
]);
export const formatValue = (key: string, value: unknown) =>
  value === null
    ? "Unavailable"
    : moneyKeys.has(key)
      ? gbp(value)
      : String(value ?? "—");
// One projection shared by HTML and exports. No clinical values or contact/address fields are returned by the RPC.
export function reportSections(r: Report): [string, Row[]][] {
  return [
    ...(r.sales
      ? [
          [
            "Sales",
            Object.entries(r.sales).map(([metric, value]) => ({
              metric,
              value,
            })),
          ] as [string, Row[]],
        ]
      : []),
    ...(r.cash
      ? [
          [
            "Cash",
            Object.entries(r.cash).map(([metric, value]) => ({
              metric,
              value,
            })),
          ] as [string, Row[]],
        ]
      : []),
    ...(r.financial
      ? [
          [
            "Financial",
            Object.entries(r.financial).map(([metric, value]) => ({
              metric,
              value,
            })),
          ] as [string, Row[]],
        ]
      : []),
    ...(r.customers
      ? [
          [
            "Customers",
            Object.entries(r.customers).map(([metric, value]) => ({
              metric:
                metric === "total"
                  ? "total_customers"
                  : metric === "new"
                    ? "new_customers"
                    : metric,
              value,
            })),
          ] as [string, Row[]],
        ]
      : []),
    ...(r.wireless
      ? [
          [
            "Wireless lights",
            Object.entries(r.wireless).map(([metric, value]) => ({
              metric,
              value,
            })),
          ] as [string, Row[]],
        ]
      : []),
    ["Representatives", r.representatives ?? []],
    ["Products", r.products ?? []],
    ["Lead sources", r.sources ?? []],
    ["Sales by month", r.months ?? []],
    ["Order pipeline", r.pipeline],
    [
      "Timing",
      Object.entries(r.durations).map(([metric, value]) => ({ metric, value })),
    ],
  ];
}
export function csvCell(v: unknown) {
  const s = String(v ?? "Unavailable");
  return (
    '"' +
    (typeof v !== "number" && /^[\s]*[=+@\-\t\r]/.test(s)
      ? "'" + s
      : s
    ).replaceAll('"', '""') +
    '"'
  );
}
export function reportCsv(r: Report, filters: Filters) {
  const lines: (string | number | null)[][] = [
    ["Elevate Dental Optics", "Management report"],
    ["From", r.from, "To", r.to, "As of", r.as_of],
    ["Filters", JSON.stringify({ ...filters, page: undefined })],
    [
      "Basis",
      "Order-date cohort excludes Draft/Cancelled; cash uses receipt/refund dates; invoices use invoice date; balances are current. Product/family/model filters select whole orders. Values GBP; product revenue excludes VAT.",
    ],
  ];
  for (const [title, rows] of reportSections(r)) {
    lines.push([], [title]);
    if (!rows.length) {
      lines.push(["No matching records"]);
      continue;
    }
    const keys = Object.keys(rows[0]);
    lines.push(keys);
    for (const row of rows)
      lines.push(keys.map((k) => row[k] ?? "Unavailable"));
  }
  return (
    "\uFEFF" +
    lines.map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
