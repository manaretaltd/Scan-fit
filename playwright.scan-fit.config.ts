import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "scan-fit.browser.spec.ts",
    "crm-scan-fit-regression.browser.spec.ts",
  ],
  outputDir: "output/scan-fit-browser",
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: "http://127.0.0.1:3007",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROME_PATH || "/usr/bin/chromium",
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/demo-scan-fit.mjs",
    url: "http://127.0.0.1:3007/login",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
