import { brandLogoBytes } from "@/lib/brand-pdf";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Invoice } from "./types";
import { addressText } from "./types";
const amount = (v: string | number) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    Number(v),
  );
export async function invoicePdf(
  invoice: Invoice,
  logo?: { bytes: Uint8Array; type: string },
) {
  logo = (await brandLogoBytes()) ?? logo;
  const s = invoice.snapshot,
    c = s.company,
    doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(170 / 255, 0, 20 / 255),
    ink = rgb(0.09, 0.13, 0.21),
    muted = rgb(0.39, 0.44, 0.42);
  let page = doc.addPage([595.28, 841.89]),
    y = 795;
  const clean = (text: string) =>
    text.replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  function text(
    value: string,
    x: number,
    yy: number,
    size = 10,
    strong = false,
    color = ink,
  ) {
    page.drawText(clean(value), {
      x,
      y: yy,
      size,
      font: strong ? bold : regular,
      color,
    });
  }
  function wrap(value: string, width: number, size = 10) {
    const out: string[] = [];
    for (const paragraph of clean(value).split("\n")) {
      let row = "";
      for (const word of paragraph.split(/\s+/)) {
        let chunk = word;
        while (regular.widthOfTextAtSize(chunk, size) > width) {
          let n = chunk.length - 1;
          while (
            n > 1 &&
            regular.widthOfTextAtSize(chunk.slice(0, n), size) > width
          )
            n--;
          if (row) {
            out.push(row);
            row = "";
          }
          out.push(chunk.slice(0, n));
          chunk = chunk.slice(n);
        }
        if (
          regular.widthOfTextAtSize(
            [row, chunk].filter(Boolean).join(" "),
            size,
          ) > width
        ) {
          out.push(row);
          row = chunk;
        } else row = [row, chunk].filter(Boolean).join(" ");
      }
      out.push(row);
    }
    return out;
  }
  function ensure(height: number) {
    if (y - height < 64) {
      page = doc.addPage([595.28, 841.89]);
      y = 790;
      text(c.legal_name, 36, y, 11, true, green);
      text(invoice.invoice_number, 370, y, 10);
      y -= 28;
    }
  }
  function paragraph(value: string, width = 523, size = 10, strong = false) {
    for (const line of wrap(value, width, size)) {
      ensure(13);
      text(line, 36, y, size, strong);
      y -= 13;
    }
  }
  text(c.trading_name || c.legal_name, 36, y, 22, true, green);
  y -= 23;
  text(
    c.trading_name ? `A trading brand of ${c.legal_name}` : c.legal_name,
    36,
    y,
    10,
  );
  y -= 34;
  if (logo) {
    const embedded =
      logo.type === "image/png"
        ? await doc.embedPng(logo.bytes)
        : await doc.embedJpg(logo.bytes);
    const scale = Math.min(76 / embedded.width, 76 / embedded.height);
    page.drawImage(embedded, {
      x: 483,
      y: 741,
      width: embedded.width * scale,
      height: embedded.height * scale,
    });
  }
  const vatInvoice =
    c.vat_registered === true &&
    /^(GB)?\d{9}(\d{3})?$/.test(c.vat_number.replace(/\s/g, ""));
  paragraph(vatInvoice ? "VAT INVOICE" : "INVOICE", 523, 18, true);
  paragraph(`${invoice.invoice_number}   |   Order EO-${s.order_number}`);
  paragraph(
    `Invoice date: ${s.invoice_date}    Supply / tax point: ${s.supply_date}`,
  );
  if (s.due_date) paragraph(`Payment due: ${s.due_date}`);
  y -= 10;
  paragraph("FROM", 523, 9, true);
  paragraph(c.legal_name);
  paragraph(c.address);
  paragraph(
    [
      c.company_number && `Company ${c.company_number}`,
      c.registration_country && `Registered in ${c.registration_country}`,
    ]
      .filter(Boolean)
      .join(" | "),
    523,
    9,
  );
  if (vatInvoice) paragraph(`VAT registration: ${c.vat_number}`, 523, 9);
  paragraph(
    [c.email, c.telephone, c.website].filter(Boolean).join(" | "),
    523,
    9,
  );
  y -= 10;
  paragraph("BILL TO", 523, 9, true);
  paragraph(s.customer_name);
  if (s.practice) paragraph(s.practice);
  paragraph(addressText(s.billing_address));
  y -= 14;
  function header() {
    ensure(55);
    page.drawRectangle({
      x: 36,
      y: y - 7,
      width: 523,
      height: 24,
      color: green,
    });
    [
      ["Description", 42],
      ["Qty", 230],
      ["Unit", 265],
      ["Discount", 322],
      ["Net", 389],
      ["VAT", 449],
      ["Total", 507],
    ].forEach(([t, x]) => text(String(t), Number(x), y, 8, true, rgb(1, 1, 1)));
    y -= 30;
  }
  header();
  for (const line of s.lines) {
    const description = wrap(
      line.description + (line.sku ? `\n${line.sku}` : ""),
      175,
      9,
    );
    const height = Math.max(43, description.length * 13 + 13);
    if (y - height < 70) {
      ensure(height);
      header();
    }
    description.forEach((row, i) => text(row, 42, y - i * 13, 9, i === 0));
    text(String(line.quantity), 230, y, 9);
    text(amount(line.unit_price), 263, y, 8);
    text(amount(line.discount), 322, y, 8);
    text(amount(line.net), 380, y, 8);
    text(amount(line.vat), 440, y, 8);
    text(amount(line.total), 500, y, 8, true);
    text(
      line.vat_applicable ? `${line.vat_rate}%` : "N/A",
      441,
      y - 13,
      8,
      false,
      muted,
    );
    y -= height;
    page.drawLine({
      start: { x: 36, y: y + 8 },
      end: { x: 559, y: y + 8 },
      thickness: 0.4,
      color: rgb(0.84, 0.87, 0.85),
    });
  }
  ensure(175);
  y -= 10;
  for (const [label, value] of [
    ["Subtotal before discounts", s.subtotal],
    ["Discount", s.discount],
    ["Net", s.net],
    ["VAT (GBP)", s.vat],
    ["TOTAL", s.total],
    ["Payments at issue", s.payments],
    ["Refunds at issue", s.refunds],
    ["BALANCE AT ISSUE", s.balance],
  ]) {
    const strong = label === "TOTAL" || label === "BALANCE AT ISSUE";
    text(label, 295, y, 10, strong);
    const valueText = amount(value);
    text(
      valueText,
      559 - (strong ? bold : regular).widthOfTextAtSize(valueText, 10),
      y,
      10,
      strong,
    );
    y -= 18;
  }
  y -= 12;
  if (c.payment_details) {
    paragraph("PAYMENT INFORMATION", 523, 9, true);
    paragraph(c.payment_details);
  }
  if (c.payment_terms) paragraph(c.payment_terms);
  if (s.notes) paragraph(s.notes);
  if (c.footer) {
    y -= 10;
    paragraph(c.footer, 523, 9);
  }
  y -= 10;
  paragraph(
    "Thank you for choosing " + (c.trading_name || c.legal_name) + ".",
    523,
    10,
    true,
  );
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`${invoice.invoice_number} | ${i + 1} / ${pages.length}`, {
      x: 36,
      y: 30,
      size: 8,
      font: regular,
      color: muted,
    });
  });
  doc.setTitle(invoice.invoice_number);
  doc.setAuthor(c.legal_name);
  return doc.save();
}
