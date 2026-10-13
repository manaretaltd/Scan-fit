import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: "client-scan.browser.spec.ts", outputDir: "output/client-browser", workers: 1, timeout: 90000,
  use: { baseURL: "http://127.0.0.1:3018", browserName: "chromium", launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH || "/usr/bin/chromium" } },
  webServer: { command: "node scripts/demo-client.mjs", url: "http://127.0.0.1:3018", reuseExistingServer: true, timeout: 120000 },
});
