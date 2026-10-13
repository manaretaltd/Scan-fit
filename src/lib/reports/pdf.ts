import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { brandLogoBytes } from "@/lib/brand-pdf";
import { brand } from "@/lib/brand";
import {
  reportSections,
  label,
  formatValue,
  type Report,
  type Filters,
} from "./model";
export async function reportPdf(report: Report, filters: Filters) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold),
    ink = rgb(0.09, 0.13, 0.21),
    red = rgb(170 / 255, 0, 20 / 255);
  const logo = await brandLogoBytes(),
    image = logo
      ? logo.type === "image/png"
        ? await doc.embedPng(logo.bytes)
        : await doc.embedJpg(logo.bytes)
      : null;
  let page = doc.addPage([595.28, 841.89]),
    y = 790;
  function heading() {
    page.drawText(brand.name, {
      x: 36,
      y: 792,
      size: 20,
      font: bold,
      color: ink,
    });
    if (image) {
      const d = image.scale(Math.min(72 / image.width, 72 / image.height));
      page.drawImage(image, {
        x: 487,
        y: 750,
        width: d.width,
        height: d.height,
      });
    }
    page.drawLine({
      start: { x: 36, y: 738 },
      end: { x: 559, y: 738 },
      thickness: 2,
      color: red,
    });
    y = 715;
  }
  function line(s: string, strong = false, size = 10) {
    const clean = s.replace(/[–—]/g, "-").replace(/\u00a0/g, " ");
    let row = "";
    const render = (t: string) => {
      if (y < 56) {
        page = doc.addPage([595.28, 841.89]);
        heading();
      }
      page.drawText(t, {
        x: 36,
        y,
        size,
        font: strong ? bold : font,
        color: ink,
      });
      y -= size + 5;
    };
    for (const word of clean.split(/\s+/)) {
      if (font.widthOfTextAtSize((row + " " + word).trim(), size) > 515) {
        if (row) render(row);
        row = "";
        let part = "";
        for (const char of word) {
          if (font.widthOfTextAtSize(part + char, size) > 515) {
            render(part);
            part = "";
          }
          part += char;
        }
        row = part;
      } else row = (row + " " + word).trim();
    }
    if (row) render(row);
  }
  heading();
  line("Management report", true, 17);
  line(`${report.from} to ${report.to} | GBP | Europe/London`);
  line(
    `Current balances/statuses as of ${report.as_of} | ${report.scope} scope`,
  );
  line(
    "Filters: " +
      Object.entries(filters)
        .filter(([k, v]) => v && k !== "page")
        .map(([k, v]) => `${label(k)}: ${v}`)
        .join(" | "),
    false,
    9,
  );
  line(
    "Order-date cohort: sales exclude Draft/Cancelled. Cash uses receipt/refund dates; invoices use invoice dates. Product filters select whole orders. Product revenue excludes VAT. Net receipts are cash, not recognised revenue. VAT collected and conversion are unavailable.",
    false,
    9,
  );
  y -= 10;
  for (const [section, rows] of reportSections(report)) {
    if (!rows.length) continue;
    if (y < 100) {
      page = doc.addPage([595.28, 841.89]);
      heading();
    }
    line(section, true, 14);
    for (const row of rows) {
      if ("metric" in row) {
        line(
          `${label(String(row.metric))}: ${formatValue(String(row.metric), row.value)}`,
        );
      } else {
        line(
          Object.entries(row)
            .filter(([k]) => !["id", "product_id", "position"].includes(k))
            .map(([k, v]) => `${label(k)}: ${formatValue(k, v)}`)
            .join(" | "),
          false,
          9,
        );
        y -= 4;
      }
    }
    y -= 12;
  }
  doc
    .getPages()
    .forEach((p, i) =>
      p.drawText(
        `${brand.name} | Confidential management report | ${i + 1}/${doc.getPageCount()}`,
        { x: 36, y: 28, size: 8, font, color: ink },
      ),
    );
  doc.setTitle(brand.name + " Management Report");
  return doc.save();
}
