import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { validateMedia, detectedMime } from "../src/lib/media/validation";
import { fileZip } from "../src/lib/media/zip";
import {
  buildManufacturerPdf,
  packText,
} from "../src/lib/orders/manufacturer-pdf";
import type { ManufacturerPack } from "../src/lib/orders/hub";
const settings = {
  id: true,
  image_limit: 20971520,
  pdf_limit: 20971520,
  video_limit: 104857600,
  pack_limit: 52428800,
  max_pack_files: 30,
  manufacturer_name: "",
  manufacturer_email: "",
  allowed_mimes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
    "video/mp4",
    "video/quicktime",
  ],
};
const root = "tests/fixtures/media";
await mkdir(root, { recursive: true });
const jpg = await sharp({
  create: { width: 800, height: 600, channels: 3, background: "#48a5ad" },
})
  .jpeg()
  .toBuffer();
const pdf = await PDFDocument.create();
pdf
  .addPage([400, 400])
  .drawText("TEST prescription - synthetic only", { x: 25, y: 350, size: 14 });
const pdfBytes = await pdf.save();
await writeFile(root + "/test-photo.jpg", jpg);
await writeFile(root + "/test-prescription.pdf", pdfBytes);
test("JPEG validates and creates smaller separate thumbnail preserving original", async () => {
  const r = await validateMedia(jpg, "image/jpeg", settings);
  assert.equal(r.mime, "image/jpeg");
  assert.ok(r.thumbnail);
  assert.ok(r.thumbnail.length < jpg.length);
});
test("PDF parsing accepts readable PDF and rejects encrypted/corrupt headers", async () => {
  assert.equal(
    (await validateMedia(pdfBytes, "application/pdf", settings)).mime,
    "application/pdf",
  );
  await assert.rejects(() =>
    validateMedia(
      Buffer.from("%PDF-1.4\nnot a document"),
      "application/pdf",
      settings,
    ),
  );
});
test("MIME mismatch, executable disguise, corrupt image and size limit rejected", async () => {
  await assert.rejects(
    () => validateMedia(jpg, "application/pdf", settings),
    /match/,
  );
  await assert.rejects(
    () =>
      validateMedia(
        Buffer.from("MZ executable disguised as photo"),
        "image/jpeg",
        settings,
      ),
    /Unsupported/,
  );
  await assert.rejects(
    () =>
      validateMedia(
        Buffer.from([255, 216, 255, ...Array(40).fill(0)]),
        "image/jpeg",
        settings,
      ),
    /decoded/,
  );
  await assert.rejects(
    () => validateMedia(jpg, "image/jpeg", { ...settings, image_limit: 10 }),
    /limit/,
  );
});
test("complete MP4 container accepted and truncated video rejected", async () => {
  const video = await readFile(root + "/test-video.mp4");
  assert.equal(
    (await validateMedia(video, "video/mp4", settings)).mime,
    "video/mp4",
  );
  await assert.rejects(() =>
    validateMedia(video.subarray(0, 50), "video/mp4", settings),
  );
});
test("HEIC detection rejects incomplete containers before preview fallback", async () => {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(24);
  b.write("ftyp", 4);
  b.write("heic", 8);
  b.write("heic", 16);
  assert.equal(detectedMime(b), "image/heic");
  await assert.rejects(
    () => validateMedia(b, "image/heic", settings),
    /Incomplete/,
  );
});
test("ZIP preserves originals and sanitizes traversal paths", async () => {
  const zip = fileZip([
    { name: "../photo.jpg", bytes: jpg },
    { name: "prescription.pdf", bytes: pdfBytes },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(!zip.includes(Buffer.from("../")));
  await writeFile(root + "/test-package.zip", zip);
});
test("manufacturer PDF includes required non-financial configuration, attached image and PDF", async () => {
  const pack: ManufacturerPack = {
    id: "test",
    order_id: "test",
    prepared_by: "test",
    created_at: "2026-09-29T10:00:00Z",
    instructions: "TEST ONLY - align optical centres",
    file_ids: ["image", "pdf"],
    version: 2,
    snapshot: {
      order_number: 1234,
      order_date: "2026-09-29",
      sales_representative: "Alex Morgan",
      manufacturer_reference: "TEST-MFG-42",
      expected_completion_date: "2026-11-10",
      customer: { name: "Synthetic Dentist", practice: "Test Practice" },
      measurements: {
        right_bd: 31,
        left_bd: 32,
        total_bd: 63,
        working_distance: 450,
        measurement_date: "2026-09-29",
        measured_by_name: "Alex Morgan",
        notes: "Synthetic measurements",
      },
      prescription: {
        required: true,
        right_eye: { sphere: -1, cylinder: -0.5, axis: 90 },
        left_eye: { sphere: -1.25, cylinder: -0.25, axis: 80 },
        prescription_date: "2026-09-01",
        notes: "Prescription original attached",
      },
      items: [
        {
          sku: "LOUPE-EL",
          description: "EL",
          kind: "Loupe",
          quantity: 1,
          configuration: {
            magnification: "4x",
            frame: "Sport",
            frame_size: "Medium",
            frame_colour: "Black",
            working_distance: "450",
            manufacturer_instructions: "TEST ONLY - align optical centres",
          },
        },
        {
          sku: "LIGHT-WIRELESS",
          description: "Wireless light",
          kind: "Light",
          quantity: 1,
          configuration: {},
        },
        {
          sku: "BATTERY",
          description: "Spare battery",
          kind: "Accessory",
          quantity: 1,
          configuration: {},
        },
      ],
      attachments: [
        {
          id: "image",
          filename: "test-photo.jpg",
          mime_type: "image/jpeg",
          size_bytes: jpg.length,
        },
        {
          id: "pdf",
          filename: "test-prescription.pdf",
          mime_type: "application/pdf",
          size_bytes: pdfBytes.length,
        },
      ],
    },
  };
  const text = JSON.stringify(packText(pack));
  for (const word of [
    "EO-1234",
    "4x",
    "Sport",
    "Medium",
    "Black",
    "450",
    "right bd: 31",
    "total bd: 63",
    "Wireless light",
    "Spare battery",
    "-1.25",
    "TEST ONLY",
  ])
    assert.ok(text.includes(word), word);
  for (const word of [
    "unit_price",
    "subtotal",
    "discount",
    "VAT",
    "payments",
    "outstanding",
  ])
    assert.ok(!text.includes(word));
  const bytes = await buildManufacturerPdf(pack, [
    { filename: "test-photo.jpg", mime_type: "image/jpeg", bytes: jpg },
    {
      filename: "test-prescription.pdf",
      mime_type: "application/pdf",
      bytes: pdfBytes,
    },
  ]);
  const document = await PDFDocument.load(bytes);
  assert.ok(document.getPageCount() >= 3);
  await mkdir("output/pdf", { recursive: true });
  await writeFile("output/pdf/phase6-manufacturer-test-v2.pdf", bytes);
});
