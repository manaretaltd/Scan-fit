import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { fileLimit, type MediaSettings } from "./types";
export function detectedMime(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes),
    text = (a: number, z: number) => b.subarray(a, z).toString("ascii");
  if (b.length < 12) return null;
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  if (text(0, 5) === "%PDF-") return "application/pdf";
  if (b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return "video/webm";
  if (text(4, 8) === "ftyp") {
    const n = b.readUInt32BE(0);
    if (n < 16 || n > b.length || n > 4096) return null;
    const brands = [];
    for (let i = 8; i < n; i += 4) brands.push(text(i, i + 4));
    if (brands.some((v) => ["heic", "heix", "hevc", "hevx"].includes(v)))
      return "image/heic";
    if (brands.some((v) => ["mif1", "msf1"].includes(v))) return "image/heif";
    if (brands.includes("qt  ")) return "video/quicktime";
    if (
      brands.some((v) =>
        ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "].includes(v),
      )
    )
      return "video/mp4";
  }
  return null;
}
export async function validateMedia(
  bytes: Uint8Array,
  claimed: string,
  settings: MediaSettings,
) {
  const mime = detectedMime(bytes);
  if (!mime || !settings.allowed_mimes.includes(mime))
    throw Error(
      "Unsupported file contents. Use JPEG, PNG, WebP, HEIC, PDF, MP4 or MOV.",
    );
  if (
    claimed &&
    claimed !== "application/octet-stream" &&
    claimed !== mime &&
    !(claimed.startsWith("image/hei") && mime.startsWith("image/hei"))
  )
    throw Error(
      "File contents do not match its declared type. Export the original file again.",
    );
  if (!bytes.length || bytes.length > fileLimit(mime, settings))
    throw Error("File exceeds the configured size limit.");
  if (mime.startsWith("image/hei") || mime.startsWith("video/")) {
    const b = Buffer.from(bytes);
    let i = 0,
      media = false,
      metadata = false,
      imageMetadata = false;
    while (i + 8 <= b.length) {
      let size = b.readUInt32BE(i);
      const type = b.subarray(i + 4, i + 8).toString("ascii");
      if (size === 1) {
        if (i + 16 > b.length) throw Error("Invalid video container.");
        const big = b.readBigUInt64BE(i + 8);
        if (big > BigInt(b.length)) throw Error("Invalid video container.");
        size = Number(big);
      }
      if (size === 0) size = b.length - i;
      if (size < 8 || i + size > b.length)
        throw Error("Invalid video container.");
      media ||= type === "mdat";
      metadata ||= type === "moov";
      imageMetadata ||= type === "meta";
      i += size;
    }
    if (
      i !== b.length ||
      (mime.startsWith("image/hei") ? !imageMetadata : !media || !metadata)
    )
      throw Error(
        "Incomplete media container. Export a complete original and retry.",
      );
  }
  let thumbnail: Uint8Array | undefined;
  if (mime.startsWith("image/")) {
    try {
      thumbnail = await sharp(bytes, { limitInputPixels: 40000000 })
        .rotate()
        .resize({
          width: 640,
          height: 640,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch {
      if (!mime.startsWith("image/hei"))
        throw Error(
          "Image cannot be decoded or exceeds the 40 megapixel limit.",
        );
    }
  } else if (mime === "application/pdf") {
    try {
      const doc = await PDFDocument.load(bytes);
      if (!doc.getPageCount() || doc.getPageCount() > 200) throw Error();
    } catch {
      throw Error(
        "Use a readable, unencrypted PDF with no more than 200 pages.",
      );
    }
  }
  return { mime, thumbnail };
}
