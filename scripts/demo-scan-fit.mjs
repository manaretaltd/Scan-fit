// Synthetic local backend only. No production data or external image processing.
process.env.PHASE_SCAN_FIT_DEMO = "1";
process.env.SCAN_FIT_ALLOW_TEST_ORDER_WRITES = "1";
await import("./demo-phase7.mjs");
