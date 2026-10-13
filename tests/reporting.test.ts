import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateRange,
  parseFilters,
  reportCsv,
  reportSections,
  csvCell,
  type Report,
} from "../src/lib/reports/model";
import { commercialName, productSchema } from "../src/lib/products/schema";
test("UK report presets handle week, quarter, leap year, month and timezone boundaries", () => {
  const now = new Date("2026-03-31T23:30:00Z");
  assert.deepEqual(dateRange("Today", now), {
    from: "2026-04-01",
    to: "2026-04-01",
  });
  assert.deepEqual(dateRange("This Week", now), {
    from: "2026-03-30",
    to: "2026-04-01",
  });
  assert.deepEqual(dateRange("Last Month", now), {
    from: "2026-03-01",
    to: "2026-03-31",
  });
  assert.deepEqual(dateRange("This Quarter", now), {
    from: "2026-04-01",
    to: "2026-04-01",
  });
  assert.deepEqual(dateRange("This Year", now), {
    from: "2026-01-01",
    to: "2026-04-01",
  });
  assert.equal(
    dateRange("Last Month", new Date("2024-03-10T12:00:00Z")).to,
    "2024-02-29",
  );
});
test("filters reject reverse ranges, unknown presets and UUID injection", () => {
  for (const p of [
    { preset: "Custom", from: "2026-04-02", to: "2026-04-01" },
    { preset: "nonsense" },
    { rep: "1 OR true" },
  ])
    assert.throws(() => parseFilters(p));
});
test("CSV keeps amounts numeric and neutralizes formula injection including whitespace", () => {
  assert.equal(csvCell('=HYPERLINK("evil")'), '"\'=HYPERLINK(""evil"")"');
  assert.ok(csvCell("  +CMD").startsWith("\"'"));
  assert.equal(csvCell(120.5), '"120.5"');
  assert.equal(csvCell(-120.5), '"-120.5"');
  const r = {
    scope: "administrator",
    from: "2026-09-01",
    to: "2026-09-30",
    as_of: "2026-09-30",
    sales: { net_sales: 1800 },
    pipeline: [],
    durations: {},
    records: [],
    records_total: 0,
  } as Report;
  const s = reportCsv(r, { from: r.from, to: r.to, page: 0 });
  assert.match(s, /"net_sales","1800"/);
  assert.match(s, /Elevate Dental Optics/);
});
test("commercial names preserve manufacturer identity and reject unsafe product values", () => {
  assert.equal(commercialName("ET1", "ERGO"), "ET1 / ELEVATE ERGO™");
  assert.equal(commercialName("EL", ""), "EL");
  assert.equal(productSchema.safeParse({ id: "bad" }).success, false);
});

test("customer counts are not formatted as monetary totals", () => {
  const report = {
    customers: { total: 2, new: 1 },
    pipeline: [],
    durations: {},
  } as unknown as Report;
  const rows = reportSections(report).find(
    ([name]) => name === "Customers",
  )![1];
  assert.equal(rows[0].metric, "total_customers");
});
