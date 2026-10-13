import { test, expect } from "@playwright/test";
test("staff customer workflow and responsive layouts against HTTP fixtures", async ({
  page,
}) => {
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login/);
  await page
    .getByRole("textbox", { name: /^Email/ })
    .fill("staff@example.test");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Good to see you, Alex." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Customers", exact: true }).click();
  await page.getByRole("link", { name: "New customer" }).click();
  await page.getByLabel("First name").fill("Ada");
  await page.getByLabel("Last name").fill("Dentist");
  await page.getByRole("textbox", { name: /^Email/ }).fill("ada@example.test");
  await page.getByLabel("Mobile", { exact: true }).fill("07700 900123");
  await page.getByLabel("Profession", { exact: true }).fill("Dentist");
  await page
    .getByLabel("Practice name", { exact: true })
    .fill("Example Dental");
  await page
    .getByRole("group", { name: "Practice address" })
    .getByLabel("Address line 1")
    .fill("1 Test Road");
  await page
    .getByRole("group", { name: "Delivery address" })
    .getByLabel("Address line 1")
    .fill("2 Test Road");
  await page
    .getByLabel("Assigned sales representative")
    .selectOption({ label: "Alex Morgan" });
  await page
    .getByRole("button", { name: "Create customer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ada Dentist" }),
  ).toBeVisible();
  await expect(page.getByText("1 Test Road")).toBeVisible();
  const profile = page.url().split("?")[0];
  await page.getByRole("link", { name: "Edit customer" }).click();
  await page.getByLabel("Job title").fill("Principal dentist");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText("Principal dentist", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Customers", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search customers" })
    .fill("ada@example.test");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link").filter({ hasText: "Ada Dentist" }).click();
  await page.getByRole("link", { name: "Add activity", exact: true }).click();
  await page
    .getByLabel("Description")
    .fill("Discussed a practice demonstration.");
  await page.getByRole("button", { name: "Add activity", exact: true }).click();
  await expect(
    page.getByText("Discussed a practice demonstration.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Create task", exact: true }).click();
  await page.getByLabel("Title").fill("Arrange demo");
  await page.getByLabel("Due date").fill("2026-10-01");
  await page.getByLabel("Assigned to").selectOption({ label: "Alex Morgan" });
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Arrange demo" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
  await page.getByRole("link", { name: "Upload file", exact: true }).click();
  await page
    .getByLabel("Document or photo")
    .setInputFiles({
      name: "demo.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nfixture document\n%%EOF"),
    });
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  await expect(page.getByText("demo.pdf", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("demo.pdf");
  await page.goto("/customers/new");
  await page.getByLabel("First name").fill("Ada");
  await page.getByLabel("Last name").fill("Dentist");
  await page.getByRole("textbox", { name: /^Email/ }).fill("ada@example.test");
  await page
    .getByLabel("Practice name", { exact: true })
    .fill("Example Dental");
  await page
    .getByRole("button", { name: "Create customer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Possible existing customer" }),
  ).toBeVisible();
  await expect(page.getByLabel("First name")).toHaveValue("Ada");
  await expect(page.getByRole("textbox", { name: /^Email/ })).toHaveValue(
    "ada@example.test",
  );
  await page.getByRole("button", { name: "Create Anyway" }).click();
  await expect(
    page.getByRole("heading", { name: "Ada Dentist" }),
  ).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/customers",
      profile,
      `${profile}?tab=tasks`,
      "/customers/new",
    ]) {
      await page.goto(path);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.goto("/customers");
    await page.screenshot({
      path: `test-results/customers-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
});
