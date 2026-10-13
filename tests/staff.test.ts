import test from "node:test";
import assert from "node:assert/strict";
import { staffSchema, passwordSchema } from "../src/lib/staff/schema";
test("staff validation restricts roles and validates contact fields", () => {
  const value = {
    first_name: " Sarah ",
    last_name: "Jones",
    email: "Sarah@example.test",
    mobile: "",
    role: "sales",
  };
  assert.equal(staffSchema.parse(value).email, "sarah@example.test");
  for (const bad of [
    { ...value, role: "superadmin" },
    { ...value, email: "bad" },
    { ...value, first_name: "" },
    { ...value, mobile: "x".repeat(41) },
  ])
    assert.equal(staffSchema.safeParse(bad).success, false);
});
test("password confirmation and length cannot be bypassed", () => {
  assert.equal(
    passwordSchema.safeParse({
      password: "long secure phrase",
      confirm: "long secure phrase",
    }).success,
    true,
  );
  for (const v of [
    { password: "short", confirm: "short" },
    { password: "long secure phrase", confirm: "different" },
    { password: "x".repeat(129), confirm: "x".repeat(129) },
  ])
    assert.equal(passwordSchema.safeParse(v).success, false);
});
