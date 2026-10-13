import { brandLogoBytes } from "@/lib/brand-pdf";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import type { ManufacturerPack } from "./hub";
export type PackAttachment = {
  filename: string;
  mime_type: string;
  bytes: Uint8Array;
};
// Explicit field allowlist. This module must never receive or render financial totals.
export function packText(pack: ManufacturerPack): [string, string[]][] {
  const s = pack.snapshot,
    m = s.measurements,
    p = s.prescription;
  const show = (v: unknown) =>
    v == null || v === "" ? "Not supplied" : String(v);
  const eye = (side: string) => {
    const values = p?.[side] as Record<string, unknown> | undefined;
    return ["sphere", "cylinder", "axis", "add", "prism"]
      .map((k) => `${k}: ${show(values?.[k])}`)
      .join(" | ");
  };
  return [
    [
      "Order",
      [
        `Order: EO-${s.order_number}`,
        `Order date: ${show(s.order_date)}`,
        `Sales representative: ${show(s.sales_representative)}`,
        `Pack version: ${pack.version ?? "Legacy"}`,
        `Customer: ${s.customer.name}`,
        `Practice: ${s.customer.practice}`,
        `Manufacturer reference: ${show(s.manufacturer_reference)}`,
        `Expected completion: ${show(s.expected_completion_date)}`,
        `Prepared: ${pack.created_at.slice(0, 10)}`,
      ],
    ],
    [
      "Products",
      s.items.flatMap((i) => [
        `${i.description} (${i.sku}) x ${i.quantity}`,
        ...(i.kind === "Loupe"
          ? [
              `Manufacturer: ${i.manufacturer_name || "Easysee"}`,
              `Manufacturer model: ${i.manufacturer_model || i.description}`,
              `Commercial name: ${i.commercial_name ? "ELEVATE " + i.commercial_name + "™" : "Not assigned"}`,
            ]
          : []),
        ...[
          "magnification",
          "frame",
          "frame_size",
          "frame_colour",
          "working_distance",
          "manufacturer_instructions",
        ]
          .filter((k) => i.configuration[k])
          .map((k) => `${k.replaceAll("_", " ")}: ${i.configuration[k]}`),
      ]),
    ],
    [
      "Measurements",
      [
        "right_bd",
        "left_bd",
        "total_bd",
        "working_distance",
        "measurement_date",
        "measured_by_name",
        "notes",
      ].map((k) => `${k.replaceAll("_", " ")}: ${show(m?.[k])}`),
    ],
    [
      "Prescription",
      [
        `Required: ${p?.required ? "Yes" : "No"}`,
        ...(p?.required
          ? [
              `Right eye: ${eye("right_eye")}`,
              `Left eye: ${eye("left_eye")}`,
              `Provider: ${show(p.provider)}`,
              `Date: ${show(p.prescription_date)}`,
              `Notes: ${show(p.notes)}`,
            ]
          : []),
      ],
    ],
    [
      "Manufacturer instructions",
      [pack.instructions || "No additional instructions."],
    ],
  ];
}
export async function buildManufacturerPdf(
  pack: ManufacturerPack,
  attachments: PackAttachment[],
) {
  if (
    attachments.length > 30 ||
    attachments.reduce((n, f) => n + f.bytes.length, 0) > 50 * 1024 * 1024
  )
    throw new Error(
      "The selected files exceed the 50 MB pack limit. Prepare a smaller pack.",
    );
  const doc = await PDFDocument.create();
  doc.setTitle(`Elevate EO-${pack.snapshot.order_number} - Manufacturer order`);
  doc.setAuthor("Elevate Dental Optics");
  const regular = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]),
    y = 790;
  const clean = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff\n\u2122]/g, "-");
  function newPage() {
    page = doc.addPage([595, 842]);
    y = 790;
  }
  function line(text: string, heading = false) {
    const font = heading ? bold : regular,
      size = heading ? 14 : 10.5;
    const width = 491;
    for (const paragraph of clean(text).split("\n")) {
      let current = "";
      for (const word of paragraph.split(/\s+/)) {
        for (const part of word.match(/.{1,60}/g) ?? [""]) {
          const test = current ? current + " " + part : part;
          if (font.widthOfTextAtSize(test, size) > width && current) {
            draw(current);
            current = part;
          } else current = test;
        }
      }
      draw(current);
    }
    function draw(value: string) {
      if (y < 64) newPage();
      page.drawText(value, {
        x: 52,
        y,
        size,
        font,
        color: rgb(0.09, 0.13, 0.21),
      });
      y -= heading ? 23 : 16;
    }
  }
  const logo = await brandLogoBytes();
  if (logo) {
    const embedded =
      logo.type === "image/png"
        ? await doc.embedPng(logo.bytes)
        : await doc.embedJpg(logo.bytes);
    const scale = Math.min(72 / embedded.width, 72 / embedded.height);
    page.drawImage(embedded, {
      x: 471,
      y: 754,
      width: embedded.width * scale,
      height: embedded.height * scale,
    });
  }
  line("ELEVATE DENTAL OPTICS", true);
  line("MANUFACTURER ORDER", true);
  line("Prepared order pack - ready for manual review and emailing");
  y -= 15;
  for (const [title, lines] of packText(pack)) {
    if (y < 125) newPage();
    line(title.toUpperCase(), true);
    for (const text of lines) line(text);
    y -= 14;
  }
  if (pack.snapshot.attachments?.length) {
    line("ATTACHMENT MANIFEST", true);
    for (const file of pack.snapshot.attachments)
      line(
        `${file.filename} (${file.mime_type})${file.mime_type.startsWith("video/") || file.mime_type.startsWith("image/hei") ? " - original provided separately in document package" : " - included below"}`,
      );
  }
  if (attachments.length) {
    line(
      `${attachments.length} original attachments follow on separate pages.`,
    );
  }

  for (const a of attachments) {
    try {
      if (a.mime_type === "application/pdf") {
        const pdf = await PDFDocument.load(a.bytes);
        if (
          pdf.getPageCount() > 100 ||
          doc.getPageCount() + pdf.getPageCount() > 200
        )
          throw new Error("Too many PDF pages");
        const pages = await doc.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((p) => doc.addPage(p));
      } else if (
        ["image/jpeg", "image/png", "image/webp"].includes(a.mime_type)
      ) {
        const png = await sharp(a.bytes, { limitInputPixels: 40000000 })
          .rotate()
          .resize({
            width: 2000,
            height: 2400,
            fit: "inside",
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
        const img = await doc.embedPng(png);
        newPage();
        line(a.filename, true);
        const scale = Math.min(491 / img.width, 680 / img.height);
        page.drawImage(img, {
          x: (595 - img.width * scale) / 2,
          y: 85 + (680 - img.height * scale) / 2,
          width: img.width * scale,
          height: img.height * scale,
        });
      } else throw new Error("Unsupported attachment");
    } catch {
      throw new Error(
        `Cannot include ${a.filename}. Use a readable, unencrypted PDF or supported image and prepare a new pack.`,
      );
    }
  }
  const pages = doc.getPages();
  pages.forEach((p, i) =>
    p.drawText(
      `Elevate EO-${pack.snapshot.order_number} | ${i + 1} / ${pages.length}`,
      { x: 32, y: 20, size: 8, font: regular, color: rgb(0.35, 0.4, 0.37) },
    ),
  );
  return doc.save();
}
