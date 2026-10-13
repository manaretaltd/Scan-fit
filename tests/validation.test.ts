import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customerSchema,
  taskSchema,
  detectFileType,
  pageNumber,
} from "../src/lib/validation";
const customer = {
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@example.test",
  mobile: "07700 900123",
  alternative_phone: "",
  profession: "Dentist",
  job_title: "",
  gdc_number: "123456",
  practice_name: "Example Dental",
  practice_telephone: "",
  assigned_to: "",
  lead_source: "Website",
  status: "Lead",
  preferred_contact: "Email",
  notes: "",
};
test("customer validation rejects invalid contact data and missing names", () => {
  assert.equal(customerSchema.safeParse(customer).success, true);
  for (const invalid of [
    { first_name: "   " },
    { email: "invalid" },
    { assigned_to: "not-a-uuid" },
    { status: "Confirmed" },
    { notes: "x".repeat(10001) },
  ])
    assert.equal(
      customerSchema.safeParse({ ...customer, ...invalid }).success,
      false,
    );
});
test("task due dates must exist in the calendar", () => {
  const base = {
    customer_id: "11111111-1111-4111-8111-111111111111",
    title: "Call dentist",
    description: "",
    assigned_to: "11111111-1111-4111-8111-111111111111",
    priority: "High",
  };
  assert.equal(
    taskSchema.safeParse({ ...base, due_date: "2026-02-30" }).success,
    false,
  );
  assert.equal(
    taskSchema.safeParse({ ...base, due_date: "2026-09-30" }).success,
    true,
  );
});
test("upload content checks reject disguised HTML and SVG", () => {
  const encode = (s: string) => new TextEncoder().encode(s);
  assert.equal(detectFileType(encode("<html>not a PDF</html>")), null);
  assert.equal(detectFileType(encode("<svg></svg>")), null);
  assert.equal(detectFileType(encode("%PDF-1.7")), "application/pdf");
  assert.equal(
    detectFileType(new Uint8Array([255, 216, 255, 0])),
    "image/jpeg",
  );
  assert.equal(
    detectFileType(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/png",
  );
  assert.equal(detectFileType(encode("RIFF1234WEBP")), "image/webp");
});
test("pagination rejects fractional, negative and unbounded offsets", () => {
  for (const value of ["-3", "NaN", "0", "1.4", undefined])
    assert.equal(pageNumber(value), 1);
  assert.equal(pageNumber("999999999999"), 100000);
  assert.equal(pageNumber("2"), 2);
});
