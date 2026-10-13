import sharp from "sharp";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { brand } from "./brand";
export async function brandLogoBytes() {
  if (!brand.logoPath) return undefined;
  const bytes = await readFile(
    path.join(process.cwd(), "public", brand.logoPath),
  );
  if (/\.(png|jpe?g)$/i.test(brand.logoPath))
    return {
      bytes: new Uint8Array(bytes),
      type: brand.logoPath.toLowerCase().endsWith(".png")
        ? "image/png"
        : "image/jpeg",
    };
  // Rasterize only the PDF embedding; the supplied web asset is unchanged.
  return {
    bytes: new Uint8Array(await sharp(bytes).png().toBuffer()),
    type: "image/png",
  };
}
