import { test, expect } from "@playwright/test";
test("existing customer editing and follow-up workflow with the Scan Fit module installed", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByRole("textbox", { name: /Email/ }).fill("admin@example.test");
  await page.getByLabel(/^Password/).fill("Fixture-password-123!");
  await page.getByRole("button", { name: "Log In", exact: true }).click();
  await expect(page).not.toHaveURL(/login/);
  const stamp = String(Date.now());
  await page.goto("/customers/new");
  await page.getByLabel(/^First name/).fill("Regression");
  await page.getByLabel(/^Last name/).fill("Dentist");
  await page
    .getByRole("textbox", { name: /^Email/ })
    .fill("regression-" + stamp + "@example.test");
  await page
    .getByLabel("Mobile", { exact: true })
    .fill("07700" + stamp.slice(-6));
  await page
    .getByLabel("Practice name", { exact: true })
    .fill("Synthetic regression practice " + stamp);
  await page
    .getByLabel("Assigned sales representative")
    .selectOption({ label: "Alex Morgan" });
  await page
    .getByRole("button", { name: "Create customer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Regression Dentist", exact: true }),
  ).toBeVisible();
  const profile = page.url().split("?")[0];
  await expect(
    page.getByRole("link", { name: "Start Scan Fit", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Edit customer", exact: true }).click();
  await page.getByLabel("Job title", { exact: true }).fill("Principal dentist");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Principal dentist", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Add activity", exact: true }).click();
  await page
    .getByLabel("Description", { exact: true })
    .fill("Synthetic follow-up remains available.");
  await page.getByRole("button", { name: "Add activity", exact: true }).click();
  await expect(
    page.getByText("Synthetic follow-up remains available.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Create task", exact: true }).click();
  await page.getByLabel(/^Title/).fill("Scan Fit regression follow-up");
  await page.getByLabel(/^Due date/).fill("2026-10-20");
  await page.getByLabel(/^Assigned to/).selectOption({ label: "Alex Morgan" });
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Scan Fit regression follow-up",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Mark complete", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reopen", exact: true }),
  ).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/customers",
      profile,
      profile + "?tab=tasks",
      "/customers/new",
    ]) {
      await page.goto(path);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBeTruthy();
    }
  }
});
