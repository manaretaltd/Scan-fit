import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { randomUUID, createHash } from "node:crypto";
import { emptyDraft } from "../src/lib/orders/model";
import { syntheticObservation, syntheticProfile } from "./scan-fit-fixtures";

const origin = "http://127.0.0.1:3007",
  backend = "http://127.0.0.1:54334";
test("synthetic Scan Fit workflow: calibration, private burst, correction, review, test order and re-login", async ({
  page,
  request,
}) => {
  const state = await (await request.get(backend + "/__state")).json();
  const token = await (
    await request.post(backend + "/auth/v1/token?grant_type=password", {
      data: { email: "admin@example.test", password: "Fixture-password-123!" },
    })
  ).json();
  const draftId = randomUUID();
  const draft = await request.post(backend + "/rest/v1/rpc/save_order", {
    headers: { Authorization: "Bearer " + token.access_token },
    data: {
      p_id: draftId,
      p_payload: emptyDraft(state.customer_id),
      p_expected_version: 0,
    },
  });
  expect(draft.ok(), await draft.text()).toBeTruthy();
  const unauthorized = await request.post(origin + "/api/scan-fit", {
    headers: { Origin: origin },
    data: { operation: "start", payload: {} },
  });
  expect(unauthorized.ok()).toBeFalsy();
  await page.goto("/login");
  await page.getByRole("textbox", { name: /Email/ }).fill("admin@example.test");
  await page.getByLabel(/^Password/).fill("Fixture-password-123!");
  await page.getByRole("button", { name: "Log In", exact: true }).click();
  await expect(page).not.toHaveURL(/login/);
  await page.goto("/scan-fit/settings");
  await page
    .getByLabel("Frame name", { exact: true })
    .fill(syntheticProfile.name);
  await page.getByLabel("Model", { exact: true }).fill(syntheticProfile.model);
  await page
    .getByLabel("Version", { exact: true })
    .fill("browser-" + randomUUID().slice(0, 8));
  await page
    .getByLabel("Measured marker geometry (JSON)")
    .fill(JSON.stringify(syntheticProfile.markers));
  for (const key of ["minX", "maxX", "minY", "maxY"] as const)
    await page
      .getByLabel(key + " bound (mm)")
      .fill(String(syntheticProfile.bounds[key]));
  await page.getByLabel("Calibration notes").fill(syntheticProfile.notes);
  await page
    .getByRole("button", { name: "Save immutable calibration version" })
    .click();
  await expect(
    page.getByText(syntheticProfile.name, { exact: false }).first(),
  ).toBeVisible();
  await page.goto(
    `/scan-fit/new?customer=${state.customer_id}&order=${draftId}`,
  );
  await page.getByLabel("Calibrated fitting frame").selectOption({
    label:
      (await page
        .getByLabel("Calibrated fitting frame")
        .locator("option")
        .last()
        .textContent()) ?? "",
  });
  await page.getByLabel("This is an administrator validation session").check();
  await page.getByRole("button", { name: "Continue to camera" }).click();
  await expect(page).toHaveURL(/scan-fit\/[0-9a-f-]+$/);
  const sessionId = page.url().split("/").at(-1)!;
  await expect(
    page.getByText("Engineering validation mode.", { exact: false }),
  ).toBeVisible();
  // Real MediaPipe inference runs locally on supplied samples; no metric ground truth is asserted.
  for (const file of [
    "manual-fitting-example-1.jpg",
    "manual-fitting-example-2.jpg",
  ]) {
    await page
      .getByLabel("Development photo")
      .setInputFiles("/workspace/fit-scan-handoff/test-fixtures/" + file);
    await expect(page.getByText(/Both iris centres: detected/)).toBeVisible({
      timeout: 30000,
    });
    await expect(
      page.getByText(/Insufficient calibrated markers/).last(),
    ).toBeVisible();
  }
  const observations = Array.from({ length: 5 }, (_, i) =>
    syntheticObservation(i),
  );
  const multipart: Record<
    string,
    string | { name: string; mimeType: string; buffer: Buffer }
  > = { session_id: sessionId, observations: JSON.stringify(observations) };
  for (let i = 0; i < 5; i++) {
    const generator = sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 60 + i * 2, g: 90, b: 100 },
      },
    }).composite([
      {
        input: Buffer.from(
          `<svg width="800" height="600"><text x="40" y="60" fill="white" font-size="25">SYNTHETIC GEOMETRY TEST FRAME ${i}</text></svg>`,
        ),
      },
    ]);
    const image = await (
      i === 0 ? generator.png() : generator.jpeg()
    ).toBuffer();
    multipart[`image_${i}`] = {
      name: `synthetic-${i}.${i === 0 ? "png" : "jpg"}`,
      mimeType: i === 0 ? "image/png" : "image/jpeg",
      buffer: image,
    };
  }
  await request.get(backend + "/__fail-next-scan-review-response");
  const uploaded = await page.request.put("/api/scan-fit", {
    headers: { Origin: origin },
    multipart,
  });
  expect(uploaded.status()).toBe(400);
  expect(await uploaded.text()).toContain("Simulated lost response");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Accept Scan", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Manual Review", exact: true })
    .click();
  await page.getByRole("button", { name: "Drag right pupil centre" }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByLabel("Reason for correction")
    .fill("Synthetic manual correction for browser validation");
  await page
    .getByRole("button", { name: "Save correction and recalculate" })
    .click();
  await expect(
    page.getByText("Manually adjusted", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Accept Scan", exact: true }).click();
  await expect(
    page.getByText("Accepted by a staff member.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Compare current and Scan Fit values" })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm replacement in TEST order" }),
  ).toBeDisabled();
  await page.getByLabel("I confirm this is a TEST draft order").check();
  await page
    .getByRole("button", { name: "Confirm replacement in TEST order" })
    .click();
  await expect
    .poll(async () => {
      const r = await request.get(
        backend + `/rest/v1/measurements?select=*&order_id=eq.${draftId}`,
        { headers: { Authorization: "Bearer " + token.access_token } },
      );
      const rows = await r.json();
      return rows[0]?.scan_fit_session_id;
    })
    .toBe(sessionId);
  await page
    .getByLabel("Reference method")
    .fill("Synthetic geometry reference — not clinical validation");
  for (const [field, value] of [
    ["Reference right PD (mm)", 32],
    ["Reference left PD (mm)", 31],
    ["Reference total PD (mm)", 63.2],
    ["Reference right pupil height (mm)", 20],
    ["Reference left pupil height (mm)", 21],
  ] as const)
    await page.getByLabel(field, { exact: true }).fill(String(value));
  await page
    .getByRole("button", { name: "Record reference and calculate errors" })
    .click();
  await expect(
    page.getByText("Reference measurement and errors saved."),
  ).toBeVisible();
  const frameRows = await (
    await request.get(
      backend + `/rest/v1/scan_fit_frames?select=*&session_id=eq.${sessionId}`,
      { headers: { Authorization: "Bearer " + token.access_token } },
    )
  ).json();
  const originalFrame = frameRows.find(
    (f: { frame_index: number }) => f.frame_index === 0,
  );
  const imagePath = "/api/scan-fit/images/" + originalFrame.id;
  const originalResponse = await page.request.get(imagePath);
  expect(originalResponse.status()).toBe(200);
  expect(originalResponse.headers()["content-type"]).toContain("image/png");
  expect(
    createHash("sha256")
      .update(await originalResponse.body())
      .digest("hex"),
  ).toBe(originalFrame.image_sha256);
  await page.goto(`/customers/${state.customer_id}?tab=scan%20fit`);
  await expect(
    page.getByRole("heading", { name: "Scan Fit History" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Start Scan Fit" }),
  ).toBeVisible();
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/scan-fit");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `output/scan-fit-browser/scan-fit-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/login/);
  expect((await page.request.get(imagePath)).status()).toBe(404);
  await page.getByRole("textbox", { name: /Email/ }).fill("admin@example.test");
  await page.getByLabel(/^Password/).fill("Fixture-password-123!");
  await page.getByRole("button", { name: "Log In", exact: true }).click();
  await expect(page).not.toHaveURL(/login/);
  await page.goto(`/scan-fit/${sessionId}`);
  await expect(
    page.getByText("Accepted by a staff member.", { exact: false }),
  ).toBeVisible();
});
