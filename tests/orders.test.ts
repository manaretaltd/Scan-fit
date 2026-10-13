import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lineTotals,
  totals,
  orderDraftSchema,
  emptyDraft,
  blankConfiguration,
  type Item,
} from "../src/lib/orders/model";
const line: Item = {
  id: "11111111-1111-4111-8111-111111111111",
  product_id: "22222222-2222-4222-8222-222222222222",
  quantity: 3,
  unit_price: 19.99,
  discount_type: "percent",
  discount_value: 12.5,
  discount_reason: "Offer",
  vat_rate: 20,
  configuration: blankConfiguration(),
};
test("money rounds discount before VAT in integer pennies", () =>
  assert.deepEqual(lineTotals(line), {
    subtotal: 59.97,
    discount: 7.5,
    vat: 10.49,
    total: 62.96,
  }));
test("fixed discount is per line, receipts aggregate and balance uses pennies", () => {
  const item = {
    ...line,
    discount_type: "fixed" as const,
    discount_value: 9.97,
  };
  assert.equal(lineTotals(item).total, 60);
  const t = totals({
    items: [item],
    payments: [
      {
        id: line.id,
        amount: 20.01,
        method: "Cash",
        payment_date: "2026-09-27",
        reference: "",
        notes: "",
      },
      {
        id: line.product_id,
        amount: 9.99,
        method: "Card",
        payment_date: "2026-09-27",
        reference: "",
        notes: "",
      },
    ],
  });
  assert.equal(t.paid, 30);
  assert.equal(t.balance, 30);
});
test("draft accepts incomplete clinical fields but rejects invalid ranges and fractional pennies", () => {
  const draft = emptyDraft(line.id);
  assert.ok(orderDraftSchema.safeParse(draft).success);
  assert.equal(
    orderDraftSchema.safeParse({
      ...draft,
      measurements: { ...draft.measurements, right_bd: -1 },
    }).success,
    false,
  );
  assert.equal(
    orderDraftSchema.safeParse({
      ...draft,
      items: [{ ...line, unit_price: 0.001 }],
    }).success,
    false,
  );
});
