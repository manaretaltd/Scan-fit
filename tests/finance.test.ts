import test from "node:test";
import assert from "node:assert/strict";
import { minor, decimal, percentOf } from "../src/lib/finance/money";
import {
  validWorkingDistance,
  WORKING_DISTANCE,
} from "../src/lib/orders/working-distance";
import { financeSchemas } from "../src/lib/finance/schema";
test("decimal money is exact for penny sums, refunds and percentage rounding", () => {
  assert.equal(decimal(minor("0.10") + minor("0.20")), "0.30");
  assert.equal(
    decimal(minor("1800") - minor("500") - minor("1300") + minor("200")),
    "200.00",
  );
  assert.equal(decimal(percentOf(minor("19.99"), minor("20"))), "4.00");
  assert.throws(() => minor("1.001"));
});
test("working distance bounds and legacy non-step valid values are numeric", () => {
  assert.ok(
    validWorkingDistance(350) &&
      validWorkingDistance(550) &&
      validWorkingDistance(351),
  );
  for (const n of [349, 551, 450.5, NaN])
    assert.equal(validWorkingDistance(n), false);
  assert.equal(WORKING_DISTANCE.step, 5);
});
test("financial inputs require precise amounts and valid refund references", () => {
  assert.equal(
    financeSchemas.refund.safeParse({
      payment_id: "invalid",
      amount: "1.001",
      refund_date: "2026-02-30",
      reason: "",
      reference: "",
      notes: "",
    }).success,
    false,
  );
});
