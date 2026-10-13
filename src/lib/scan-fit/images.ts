import "server-only";
import sharp from "sharp";
import { inverse, transform } from "./geometry";
import type { AnalysedFrame, FrameProfile } from "./model";

export async function scanImages(
  bytes: Buffer,
  frame: AnalysedFrame,
  profile: FrameProfile,
) {
  const metadata = await sharp(bytes, {
    limitInputPixels: 25_000_000,
  }).metadata();
  if (
    !["jpeg", "png"].includes(metadata.format ?? "") ||
    metadata.width !== frame.observation.width ||
    metadata.height !== frame.observation.height
  )
    throw Error("Image format or dimensions do not match the capture.");
  const width = metadata.width!,
    height = metadata.height!;
  const shapes = frame.observation.markers
    .map(
      (m) =>
        `<polygon points="${m.corners.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#00e0ae" stroke-width="2"/>`,
    )
    .join("");
  const pupilMarks = Object.entries(frame.observation.pupils ?? {})
    .map(
      ([side, p]) =>
        `<circle cx="${p.x}" cy="${p.y}" r="7" fill="none" stroke="${side === "right" ? "#ffca68" : "#63beff"}" stroke-width="2"/>`,
    )
    .join("");
  let midline = "";
  if (frame.homography) {
    const inv = inverse(frame.homography),
      a = transform(inv, { x: 0, y: profile.bounds.minY }),
      b = transform(inv, { x: 0, y: profile.bounds.maxY }),
      c = transform(inv, { x: profile.bounds.minX, y: 0 }),
      d = transform(inv, { x: profile.bounds.maxX, y: 0 });
    midline = `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#00e0ae" stroke-width="2"/><line x1="${c.x}" y1="${c.y}" x2="${d.x}" y2="${d.y}" stroke="#00e0ae" stroke-width="2"/>`;
  }
  const annotated = await sharp(bytes)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}">${shapes}${pupilMarks}${midline}</svg>`,
        ),
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
  let rectified: Buffer;
  if (frame.homography) {
    const scale = 4,
      b = profile.bounds,
      outW = Math.ceil((b.maxX - b.minX) * scale),
      outH = Math.ceil((b.maxY - b.minY) * scale);
    const raw = await sharp(bytes).removeAlpha().raw().toBuffer(),
      output = Buffer.alloc(outW * outH * 3),
      inv = inverse(frame.homography);
    for (let y = 0; y < outH; y++)
      for (let x = 0; x < outW; x++) {
        const p = transform(inv, {
            x: b.minX + x / scale,
            y: b.maxY - y / scale,
          }),
          sx = Math.round(p.x),
          sy = Math.round(p.y);
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
        const source = (sy * width + sx) * 3,
          target = (y * outW + x) * 3;
        output[target] = raw[source];
        output[target + 1] = raw[source + 1];
        output[target + 2] = raw[source + 2];
      }
    rectified = await sharp(output, {
      raw: { width: outW, height: outH, channels: 3 },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
  } else
    rectified = await sharp(bytes)
      .resize({ width: 640, withoutEnlargement: true })
      .jpeg()
      .toBuffer();
  return {
    original: bytes,
    originalMime: metadata.format === "png" ? "image/png" : "image/jpeg",
    annotated,
    rectified,
  };
}
