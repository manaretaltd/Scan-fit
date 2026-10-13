import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import aruco from "js-aruco2";
const { AR } = aruco;
import {
  aggregate,
  analyse,
  homography,
  inverse,
  referenceErrors,
  transform,
} from "../src/lib/scan-fit/geometry";
import { DEFAULT_CONFIG, profileSchema } from "../src/lib/scan-fit/model";
import {
  imageQuality,
  poseFromMatrix,
  irisQuality,
} from "../src/lib/scan-fit/vision";
import {
  syntheticObservation,
  syntheticProfile,
  metricToImage,
} from "./scan-fit-fixtures";

test("normalized homography recovers known metric coordinates under perspective", () => {
  const points = syntheticProfile.markers.flatMap((m) => m.corners),
    pixels = points.map((p) => transform(metricToImage, p)),
    fit = homography(pixels, points);
  assert.ok(fit.rms < 1e-8);
  const pupil = transform(
    fit.matrix,
    transform(metricToImage, { x: -32, y: 20 }),
  );
  assert.ok(Math.abs(pupil.x + 32) < 1e-8);
  assert.ok(Math.abs(pupil.y - 20) < 1e-8);
  const p = transform(inverse(fit.matrix), pupil);
  assert.ok(
    Math.hypot(
      p.x - transform(metricToImage, { x: -32, y: 20 }).x,
      p.y - transform(metricToImage, { x: -32, y: 20 }).y,
    ) < 1e-8,
  );
});
test("independently specified pixel geometry has the expected millimetre scale and upright datum", () => {
  const fit = homography(
    [
      { x: 100, y: 100 },
      { x: 700, y: 100 },
      { x: 700, y: 500 },
      { x: 100, y: 500 },
    ],
    [
      { x: -75, y: 50 },
      { x: 75, y: 50 },
      { x: 75, y: -50 },
      { x: -75, y: -50 },
    ],
  );
  const point = transform(fit.matrix, { x: 272, y: 220 });
  assert.ok(Math.abs(point.x + 32) < 1e-9);
  assert.ok(Math.abs(point.y - 20) < 1e-9);
});
test("degenerate marker geometry cannot produce a measurement", () => {
  assert.throws(() =>
    homography(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
    ),
  );
});
test("calibration rejects duplicate IDs and zero-area marker coordinates", () => {
  assert.equal(profileSchema.safeParse(syntheticProfile).success, true);
  assert.equal(
    profileSchema.safeParse({
      ...syntheticProfile,
      markers: syntheticProfile.markers.map((m) => ({ ...m, id: 0 })),
    }).success,
    false,
  );
  assert.equal(
    profileSchema.safeParse({
      ...syntheticProfile,
      markers: syntheticProfile.markers.map((m) => ({
        ...m,
        corners: Array(4).fill({ x: 0, y: 0 }),
      })),
    }).success,
    false,
  );
});
test("known frame scale determines PD and height without a depth measurement", () => {
  const f = analyse(syntheticObservation(), syntheticProfile, DEFAULT_CONFIG);
  assert.equal(f.valid, true);
  assert.ok(Math.abs(f.metric!.rightPd - 32) < 1e-8);
  assert.ok(Math.abs(f.metric!.leftPd - 31) < 1e-8);
  assert.ok(Math.abs(f.metric!.totalPd - 63) < 1e-8);
  assert.ok(Math.abs(f.metric!.rightY - 20) < 1e-8);
});
test("missing calibrated markers and iris coordinates are rejected", () => {
  const o = syntheticObservation();
  assert.equal(
    analyse(
      { ...o, markers: o.markers.slice(0, 3) },
      syntheticProfile,
      DEFAULT_CONFIG,
    ).valid,
    false,
  );
  assert.equal(
    analyse({ ...o, pupils: null }, syntheticProfile, DEFAULT_CONFIG).metric,
    null,
  );
});
test("unknown/duplicate marker IDs never satisfy the required marker count", () => {
  const o = syntheticObservation();
  assert.equal(
    analyse(
      { ...o, markers: o.markers.map((m) => ({ ...m, id: 0 })) },
      syntheticProfile,
      DEFAULT_CONFIG,
    ).valid,
    false,
  );
  assert.equal(
    analyse(
      { ...o, markers: o.markers.map((m) => ({ ...m, id: 100 + m.id })) },
      syntheticProfile,
      DEFAULT_CONFIG,
    ).valid,
    false,
  );
});
test("pose, blur, low light, glare and low iris quality each block capture", () => {
  const o = syntheticObservation();
  for (const changed of [
    { pose: { yaw: 4, pitch: 0, roll: 0 } },
    { pose: { yaw: 0, pitch: 4, roll: 0 } },
    { pose: { yaw: 0, pitch: 0, roll: 3 } },
    { sharpness: 0 },
    { brightness: 10 },
    { saturatedFraction: 0.8 },
    { pupilQuality: { right: 0.3, left: 0.95 } },
  ])
    assert.equal(
      analyse({ ...o, ...changed }, syntheticProfile, DEFAULT_CONFIG).valid,
      false,
    );
});
test("frame/facial midline disagreement and reversed pupil labels are rejected", () => {
  const o = syntheticObservation();
  assert.equal(
    analyse(
      { ...o, faceMidline: transform(metricToImage, { x: 8, y: 25 }) },
      syntheticProfile,
      DEFAULT_CONFIG,
    ).valid,
    false,
  );
  assert.equal(
    analyse(
      { ...o, pupils: { right: o.pupils!.left, left: o.pupils!.right } },
      syntheticProfile,
      DEFAULT_CONFIG,
    ).valid,
    false,
  );
});
test("marker reprojection disagreement blocks an unreliable perspective fit", () => {
  const o = syntheticObservation();
  o.markers[0].corners = o.markers[0].corners.map((p) => ({
    x: p.x + 25,
    y: p.y,
  }));
  assert.equal(analyse(o, syntheticProfile, DEFAULT_CONFIG).valid, false);
});
test("median aggregation uses at least three valid frames and retains repeatability", () => {
  const frames = Array.from({ length: 5 }, (_, i) =>
    analyse(syntheticObservation(i), syntheticProfile, DEFAULT_CONFIG),
  );
  const r = aggregate(frames, DEFAULT_CONFIG);
  assert.equal(r.validFrames, 5);
  assert.ok(
    Math.abs(r.metric.totalPd - r.metric.rightPd - r.metric.leftPd) < 1e-10,
  );
  assert.ok(r.repeatabilityMm < 0.1);
  assert.throws(
    () => aggregate(frames.slice(0, 2), DEFAULT_CONFIG),
    /At least 3/,
  );
  // Three individually good frames can still fall below the burst-level
  // quality floor because two observations were lost or rejected.
  assert.throws(
    () => aggregate(frames.slice(0, 3), DEFAULT_CONFIG),
    /Overall measurement quality is insufficient/,
  );
  assert.throws(
    () => aggregate(frames, { ...DEFAULT_CONFIG, minOverallQuality: 1 }),
    /Overall measurement quality is insufficient/,
  );
});
test("inconsistent PD or fitting heights cannot produce an accepted aggregate", () => {
  const frames = Array.from({ length: 5 }, (_, i) =>
    analyse(syntheticObservation(i), syntheticProfile, DEFAULT_CONFIG),
  );
  frames[4].metric!.rightY += 2;
  assert.throws(
    () => aggregate(frames, DEFAULT_CONFIG),
    /consistency insufficient/,
  );
});
test("reference errors report signed bias and absolute error separately", () => {
  const metric = analyse(
      syntheticObservation(),
      syntheticProfile,
      DEFAULT_CONFIG,
    ).metric!,
    r = referenceErrors(metric, {
      rightPd: 31.5,
      leftPd: 31.5,
      totalPd: 63.2,
      rightHeight: 20,
      leftHeight: 20,
    });
  assert.ok(Math.abs(r.signed.rightPd - 0.5) < 1e-8);
  assert.ok(Math.abs(r.signed.leftPd + 0.5) < 1e-8);
  assert.ok(Math.abs(r.absolute.leftPd - 0.5) < 1e-8);
  assert.ok(Math.abs(r.signed.totalPd + 0.2) < 1e-8);
});
test("head pose respects MediaPipe column-major matrix layout", () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.deepEqual(poseFromMatrix(identity), { yaw: -0, pitch: 0, roll: 0 });
  const angle = Math.PI / 18,
    rotation = [
      Math.cos(angle),
      Math.sin(angle),
      0,
      0,
      -Math.sin(angle),
      Math.cos(angle),
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    ];
  assert.ok(Math.abs(poseFromMatrix(rotation)!.roll - 10) < 1e-10);
  assert.equal(poseFromMatrix([]), null);
});
test("actual ArUco detector recognizes the selected dictionary from rendered pixels", async () => {
  const svg = new AR.Dictionary("ARUCO_MIP_36h12").generateSVG(3);
  const marker = await sharp(Buffer.from(svg))
    .resize(160, 160)
    .png()
    .toBuffer();
  const data = await sharp({
    create: { width: 300, height: 300, channels: 4, background: "white" },
  })
    .composite([{ input: marker, left: 70, top: 70 }])
    .raw()
    .toBuffer();
  const detector = new AR.Detector({
      dictionaryName: "ARUCO_MIP_36h12",
      maxHammingDistance: 1,
    }),
    markers = detector.detect({
      width: 300,
      height: 300,
      data: new Uint8ClampedArray(data),
    } as ImageData);
  assert.ok(markers.some((m) => m.id === 3));
  assert.equal(markers.find((m) => m.id === 3)!.hammingDistance, 0);
});
test("image-quality metrics respond to flat darkness and textured images", () => {
  const flat = {
    width: 100,
    height: 100,
    data: new Uint8ClampedArray(100 * 100 * 4),
  } as ImageData;
  assert.equal(imageQuality(flat).brightness, 0);
  assert.equal(imageQuality(flat).sharpness, 0);
  const textured = {
    width: 100,
    height: 100,
    data: new Uint8ClampedArray(100 * 100 * 4),
  } as ImageData;
  for (let i = 0; i < textured.data.length; i += 4) {
    const value = 40 + ((i * 13) % 180);
    textured.data[i] = value;
    textured.data[i + 1] = value;
    textured.data[i + 2] = value;
    textured.data[i + 3] = 255;
  }
  assert.ok(imageQuality(textured).sharpness > DEFAULT_CONFIG.minSharpness);
  assert.ok(imageQuality(textured).brightness > DEFAULT_CONFIG.minBrightness);
});
test("local iris glare lowers the visibility score instead of changing the detected centre", () => {
  const landmarks = Array.from({ length: 478 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 1,
  }));
  landmarks[33].x = 0.45;
  landmarks[133].x = 0.55;
  landmarks[159].y = 0.49;
  landmarks[145].y = 0.51;
  const image = (value: number) => {
    const data = new Uint8ClampedArray(100 * 100 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
    return { width: 100, height: 100, data } as ImageData;
  };
  const clear = irisQuality(
      landmarks,
      468,
      [33, 133],
      [159, 145],
      image(100),
      DEFAULT_CONFIG.maxSaturatedFraction,
    ),
    glare = irisQuality(
      landmarks,
      468,
      [33, 133],
      [159, 145],
      image(250),
      DEFAULT_CONFIG.maxSaturatedFraction,
    );
  assert.ok(clear > 0);
  assert.ok(glare < clear);
  assert.deepEqual(landmarks[468], { x: 0.5, y: 0.5, z: 0, visibility: 1 });
});
