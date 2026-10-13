import {
  ALGORITHM_VERSION,
  VISION_VERSIONS,
  type Aggregate,
  type AnalysedFrame,
  type FrameProfile,
  type Metric,
  type Observation,
  type Point,
  type ScanConfig,
} from "./model";

function solve(a: number[][], b: number[]) {
  const rows = a.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < b.length; i++) {
    let pivot = i;
    for (let j = i + 1; j < rows.length; j++)
      if (Math.abs(rows[j][i]) > Math.abs(rows[pivot][i])) pivot = j;
    if (Math.abs(rows[pivot][i]) < 1e-10)
      throw Error("Marker geometry is degenerate.");
    [rows[i], rows[pivot]] = [rows[pivot], rows[i]];
    const scale = rows[i][i];
    rows[i] = rows[i].map((x) => x / scale);
    for (let j = 0; j < rows.length; j++)
      if (j !== i) {
        const k = rows[j][i];
        rows[j] = rows[j].map((x, c) => x - k * rows[i][c]);
      }
  }
  return rows.map((r) => r.at(-1)!);
}
function multiply(a: number[], b: number[]) {
  return Array.from({ length: 9 }, (_, i) =>
    [0, 1, 2].reduce(
      (s, k) => s + a[Math.floor(i / 3) * 3 + k] * b[k * 3 + (i % 3)],
      0,
    ),
  );
}
function normalize(points: Point[]) {
  const x = points.reduce((s, p) => s + p.x, 0) / points.length,
    y = points.reduce((s, p) => s + p.y, 0) / points.length;
  const distance =
    points.reduce((s, p) => s + Math.hypot(p.x - x, p.y - y), 0) /
    points.length;
  if (distance < 1e-8) throw Error("Markers occupy insufficient image area.");
  const scale = Math.SQRT2 / distance;
  return {
    points: points.map((p) => ({ x: (p.x - x) * scale, y: (p.y - y) * scale })),
    matrix: [scale, 0, -x * scale, 0, scale, -y * scale, 0, 0, 1],
    inverse: [1 / scale, 0, x, 0, 1 / scale, y, 0, 0, 1],
  };
}
export function transform(h: number[], p: Point): Point {
  const d = h[6] * p.x + h[7] * p.y + h[8];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9)
    throw Error("Perspective transform is singular.");
  const result = {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / d,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / d,
  };
  if (!Number.isFinite(result.x) || !Number.isFinite(result.y))
    throw Error("Perspective transform is invalid.");
  return result;
}
export function inverse(h: number[]) {
  const [a, b, c, d, e, f, g, k, i] = h;
  const r = [
    e * i - f * k,
    c * k - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * k - e * g,
    b * g - a * k,
    a * e - b * d,
  ];
  const det = a * r[0] + b * r[3] + c * r[6];
  if (Math.abs(det) < 1e-12) throw Error("Perspective transform is singular.");
  return r.map((v) => v / det);
}
export function homography(source: Point[], target: Point[]) {
  if (source.length < 4 || source.length !== target.length)
    throw Error("At least four matching points are required.");
  const s = normalize(source),
    t = normalize(target),
    rows: number[][] = [],
    values: number[] = [];
  s.points.forEach((p, i) => {
    const q = t.points[i];
    rows.push(
      [p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y],
      [0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y],
    );
    values.push(q.x, q.y);
  });
  const a = Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 8 }, (_, j) =>
      rows.reduce((v, r) => v + r[i] * r[j], 0),
    ),
  );
  const b = Array.from({ length: 8 }, (_, i) =>
    rows.reduce((v, r, k) => v + r[i] * values[k], 0),
  );
  const h = multiply(t.inverse, multiply([...solve(a, b), 1], s.matrix));
  inverse(h);
  const errors = source.map((p, i) => {
    const q = transform(h, p);
    return Math.hypot(q.x - target[i].x, q.y - target[i].y);
  });
  return {
    matrix: h.map((v) => v / h[8]),
    rms: Math.sqrt(errors.reduce((v, e) => v + e * e, 0) / errors.length),
    maximum: Math.max(...errors),
  };
}
export function analyse(
  observation: Observation,
  profile: FrameProfile,
  config: ScanConfig,
): AnalysedFrame {
  const reasons: string[] = [],
    source: Point[] = [],
    target: Point[] = [];
  const seen = new Set<number>();
  for (const detected of observation.markers) {
    const known = profile.markers.find((m) => m.id === detected.id);
    if (!known || seen.has(detected.id) || detected.hammingDistance > 1)
      continue;
    seen.add(detected.id);
    source.push(...detected.corners);
    target.push(...known.corners);
  }
  const inImage = (p: Point) =>
    p.x >= 0 && p.x < observation.width && p.y >= 0 && p.y < observation.height;
  if (source.some((p) => !inImage(p)))
    reasons.push("Marker coordinates are outside the image.");
  if (seen.size < config.minMarkers)
    reasons.push("Insufficient calibrated markers — show at least four.");
  if (!observation.pupils) reasons.push("Both iris centres must be visible.");
  if (!observation.pose) reasons.push("Head pose is unavailable.");
  else {
    if (Math.abs(observation.pose.yaw) > config.maxYaw)
      reasons.push("Reduce head yaw.");
    if (Math.abs(observation.pose.pitch) > config.maxPitch)
      reasons.push("Reduce head pitch.");
    if (Math.abs(observation.pose.roll) > config.maxRoll)
      reasons.push("Level the head.");
  }
  if (
    Math.min(observation.pupilQuality.right, observation.pupilQuality.left) <
    config.minPupilQuality
  )
    reasons.push("Iris visibility is low — check reflections and eyelids.");
  if (observation.sharpness < config.minSharpness)
    reasons.push("Image is blurred — keep camera and frame still.");
  if (observation.brightness < config.minBrightness)
    reasons.push("Lighting is too low.");
  if (
    observation.brightness > config.maxBrightness ||
    observation.saturatedFraction > config.maxSaturatedFraction
  )
    reasons.push("Glare or exposure is excessive.");
  let h: number[] | null = null,
    rms: number | null = null,
    maximum: number | null = null,
    metric: Metric | null = null,
    midline: number | null = null;
  if (seen.size >= config.minMarkers)
    try {
      const fit = homography(source, target);
      h = fit.matrix;
      rms = fit.rms;
      maximum = fit.maximum;
      if (maximum > config.maxReprojectionMm)
        reasons.push(
          "Frame perspective fit is inconsistent — check calibration and markers.",
        );
      if (observation.pupils) {
        if (
          !inImage(observation.pupils.right) ||
          !inImage(observation.pupils.left)
        )
          throw Error("Pupil coordinates are outside the image.");
        const r = transform(h, observation.pupils.right),
          l = transform(h, observation.pupils.left),
          b = profile.bounds;
        if (r.x >= 0 || l.x <= 0)
          reasons.push("Check pupil labels and fitting-frame centreline.");
        if (
          [r, l].some(
            (p) => p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY,
          )
        )
          reasons.push("Pupils are outside the calibrated frame bounds.");
        metric = {
          rightPd: -r.x,
          leftPd: l.x,
          totalPd: l.x - r.x,
          rightX: r.x,
          leftX: l.x,
          rightY: r.y,
          leftY: l.y,
        };
      }
      if (observation.faceMidline) {
        midline = transform(h, observation.faceMidline).x;
        if (Math.abs(midline) > config.maxMidlineMm)
          reasons.push(
            "Frame centreline and facial midline disagree — re-centre the fitting frame.",
          );
      } else reasons.push("Facial midline could not be checked.");
    } catch (error) {
      reasons.push(
        error instanceof Error ? error.message : "Invalid marker geometry.",
      );
    }
  const frameQuality =
    maximum === null ? 0 : Math.max(0, 1 - maximum / config.maxReprojectionMm);
  if (frameQuality < config.minFrameQuality)
    reasons.push("Frame detection quality is insufficient.");
  return {
    observation,
    valid: reasons.length === 0 && metric !== null,
    reasons,
    homography: h,
    reprojectionMm: rms,
    maxReprojectionMm: maximum,
    metric,
    frameQuality,
    midlineMm: midline,
  };
}
export const median = (values: number[]) => {
  if (!values.length) throw Error("No valid measurements.");
  const sorted = [...values].sort((a, b) => a - b),
    m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
export function aggregate(
  frames: AnalysedFrame[],
  config: ScanConfig,
): Aggregate {
  const valid = frames.filter((f) => f.valid && f.metric);
  if (valid.length < config.minValidFrames)
    throw Error(
      `At least ${config.minValidFrames} valid frames are required. Please repeat the scan.`,
    );
  const keys: (keyof Metric)[] = [
    "rightPd",
    "leftPd",
    "totalPd",
    "rightX",
    "leftX",
    "rightY",
    "leftY",
  ];
  const metric = Object.fromEntries(
    keys.map((k) => [k, median(valid.map((f) => f.metric![k]))]),
  ) as Metric;
  metric.totalPd = metric.rightPd + metric.leftPd;
  const spreads = keys.map((k) => {
    const v = valid.map((f) => f.metric![k]);
    return Math.max(...v) - Math.min(...v);
  });
  const spreadMm = Math.max(...spreads);
  if (spreadMm > config.maxSpreadMm)
    throw Error(
      "Measurement consistency insufficient — please repeat the scan.",
    );
  const pd = valid.map((f) => f.metric!.totalPd),
    mean = pd.reduce((a, b) => a + b, 0) / pd.length;
  const standardDeviationMm = Math.sqrt(
    pd.reduce((s, v) => s + (v - mean) ** 2, 0) / (pd.length - 1),
  );
  const madMm = median(pd.map((v) => Math.abs(v - median(pd))));
  const qualityScore =
    median(
      valid.map((f) =>
        Math.min(
          f.frameQuality,
          f.observation.pupilQuality.right,
          f.observation.pupilQuality.left,
        ),
      ),
    ) *
    (valid.length / config.burstCount);
  if (qualityScore < config.minOverallQuality)
    throw Error("Overall measurement quality is insufficient — please repeat the scan.");
  return {
    metric,
    validFrames: valid.length,
    repeatabilityMm: spreadMm / 2,
    spreadMm,
    standardDeviationMm,
    madMm,
    qualityScore,
    confidence:
      qualityScore >= 0.85 ? "High" : qualityScore >= 0.65 ? "Medium" : "Low",
    algorithmVersion: ALGORITHM_VERSION,
    visionVersions: VISION_VERSIONS,
  };
}
export function referenceErrors(
  metric: Metric,
  reference: {
    rightPd: number;
    leftPd: number;
    totalPd?: number;
    rightHeight: number;
    leftHeight: number;
  },
) {
  const errors = {
    rightPd: metric.rightPd - reference.rightPd,
    leftPd: metric.leftPd - reference.leftPd,
    totalPd:
      metric.totalPd -
      (reference.totalPd ?? reference.rightPd + reference.leftPd),
    rightHeight: metric.rightY - reference.rightHeight,
    leftHeight: metric.leftY - reference.leftHeight,
  };
  const values = Object.values(errors);
  return {
    signed: errors,
    absolute: Object.fromEntries(
      Object.entries(errors).map(([k, v]) => [k, Math.abs(v)]),
    ),
    meanAbsoluteError:
      values.reduce((s, v) => s + Math.abs(v), 0) / values.length,
    bias: values.reduce((s, v) => s + v, 0) / values.length,
  };
}
