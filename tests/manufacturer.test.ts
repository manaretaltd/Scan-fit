import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import {
  buildManufacturerPdf,
  packText,
} from "../src/lib/orders/manufacturer-pdf";
import type { ManufacturerPack } from "../src/lib/orders/hub";
const pack: ManufacturerPack = {
  id: "pack",
  order_id: "order",
  prepared_by: "staff",
  created_at: "2026-09-28T10:00:00Z",
  instructions: "Please verify the frame fit before production.",
  file_ids: [],
  snapshot: {
    order_number: 42,
    manufacturer_reference: "M-42",
    expected_completion_date: "2026-10-20",
    customer: { name: "Example Dentist", practice: "Example Dental Practice" },
    measurements: {
      right_bd: 31.5,
      left_bd: 32,
      total_bd: 63.5,
      working_distance: 450,
      notes: "Seated position",
    },
    prescription: {
      required: true,
      right_eye: { sphere: -1, cylinder: -0.5, axis: 90 },
      left_eye: { sphere: -1.25, cylinder: 0 },
      provider: "Example Optician",
      prescription_date: "2026-09-20",
    },
    items: [
      {
        sku: "LOUPE-EL",
        description: "EL",
        kind: "Loupe",
        quantity: 1,
        configuration: {
          magnification: "4x",
          frame: "Circular frame",
          frame_colour: "Blue",
          working_distance: "450",
          manufacturer_instructions: "Check frame fit",
        },
      },
    ],
  },
};
test("PDF text uses an allowlist and excludes injected financial fields", () => {
  const contaminated = structuredClone(pack);
  Object.assign(contaminated.snapshot, {
    total: 999,
    amount_paid: 123,
    payments: [{ reference: "FINANCE SECRET" }],
  });
  Object.assign(contaminated.snapshot.items[0], {
    unit_price: 999,
    discount: 123,
  });
  Object.assign(contaminated.snapshot.measurements!, {
    finance_notes: "FINANCE SECRET",
  });
  const text = JSON.stringify(packText(contaminated));
  assert.ok(text.includes("Circular frame"));
  assert.ok(!text.includes("FINANCE SECRET"));
  assert.ok(!text.includes("999"));
  assert.ok(!text.includes("123"));
});
test("manufacturer PDF embeds an image and merges original PDF pages", async () => {
  const original = await PDFDocument.create();
  original
    .addPage([595, 842])
    .drawText("Original prescription - synthetic test document", {
      x: 50,
      y: 700,
      size: 14,
    });
  const image = await sharp({
    create: { width: 600, height: 400, channels: 3, background: "#c1d8d0" },
  })
    .png()
    .toBuffer();
  const bytes = await buildManufacturerPdf(pack, [
    { filename: "Measurement photo.png", mime_type: "image/png", bytes: image },
    {
      filename: "Prescription.pdf",
      mime_type: "application/pdf",
      bytes: await original.save(),
    },
  ]);
  const output = await PDFDocument.load(bytes);
  assert.ok(output.getPageCount() >= 3);
  await mkdir("tmp/pdfs", { recursive: true });
  await writeFile("tmp/pdfs/manufacturer-acceptance.pdf", bytes);
  await writeFile("tmp/pdfs/prescription-sample.pdf", await original.save());
  await writeFile("tmp/pdfs/measurement-sample.png", image);
});
test("unreadable PDF attachments fail explicitly rather than disappearing", async () => {
  await assert.rejects(
    () =>
      buildManufacturerPdf(pack, [
        {
          filename: "broken.pdf",
          mime_type: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-broken"),
        },
      ]),
    /Cannot include broken.pdf/,
  );
});
