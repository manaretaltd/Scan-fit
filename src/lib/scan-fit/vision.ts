import {
  FaceLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { analyse, inverse, transform } from "./geometry";
import type {
  AnalysedFrame,
  FrameProfile,
  Observation,
  Point,
  ScanConfig,
} from "./model";

export function poseFromMatrix(m: number[]) {
  // MediaPipe's matrix data uses column-major ordering. Rotation is separated from scale.
  if (m.length !== 16 || m.some((n) => !Number.isFinite(n))) return null;
  const sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]);
  if (Math.min(sx, sy, sz) < 1e-8) return null;
  return {
    yaw: (Math.asin(Math.max(-1, Math.min(1, -m[2] / sx))) * 180) / Math.PI,
    pitch: (Math.atan2(m[6] / sy, m[10] / sz) * 180) / Math.PI,
    roll: (Math.atan2(m[1] / sx, m[0] / sx) * 180) / Math.PI,
  };
}
export function imageQuality(image: ImageData) {
  const { data, width: w, height: h } = image;
  let sum = 0,
    saturated = 0,
    lap = 0,
    lapSq = 0,
    n = 0;
  const luminance = (i: number) =>
    0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  // Central capture region, sampled at native analysis resolution.
  for (let y = Math.floor(h * 0.2); y < Math.ceil(h * 0.8); y += 2)
    for (let x = Math.floor(w * 0.15); x < Math.ceil(w * 0.85); x += 2) {
      const i = (y * w + x) * 4,
        v = luminance(i);
      const d =
        4 * v -
        luminance(i - 4) -
        luminance(i + 4) -
        luminance(i - w * 4) -
        luminance(i + w * 4);
      sum += v;
      saturated += v >= 245 ? 1 : 0;
      lap += d;
      lapSq += d * d;
      n++;
    }
  return {
    brightness: sum / n,
    saturatedFraction: saturated / n,
    sharpness: Math.max(0, lapSq / n - (lap / n) ** 2),
  };
}
export function irisQuality(
  landmarks: NormalizedLandmark[],
  center: number,
  corners: [number, number],
  lids: [number, number],
  image: ImageData,
  glareLimit: number,
) {
  const p = landmarks[center],
    a = landmarks[corners[0]],
    b = landmarks[corners[1]],
    top = landmarks[lids[0]],
    bottom = landmarks[lids[1]];
  if (!p || !a || !b || !top || !bottom) return 0;
  const width = Math.hypot(a.x - b.x, a.y - b.y),
    open = Math.hypot(top.x - bottom.x, top.y - bottom.y),
    mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (width < 0.01 || Math.hypot(p.x - mid.x, p.y - mid.y) > width * 0.55)
    return 0;
  const radius = Math.max(2, Math.round(width * image.width * 0.12));
  let saturated = 0,
    count = 0;
  for (
    let y = Math.max(0, Math.round(p.y * image.height) - radius);
    y < Math.min(image.height, Math.round(p.y * image.height) + radius);
    y++
  )
    for (
      let x = Math.max(0, Math.round(p.x * image.width) - radius);
      x < Math.min(image.width, Math.round(p.x * image.width) + radius);
      x++
    ) {
      const i = (y * image.width + x) * 4,
        v =
          0.299 * image.data[i] +
          0.587 * image.data[i + 1] +
          0.114 * image.data[i + 2];
      if (v >= 245) saturated++;
      count++;
    }
  const glarePenalty = count
    ? Math.max(0, 1 - saturated / count / glareLimit)
    : 0;
  // Visibility/glare heuristic, never a calibrated probability or eye-opening substitute.
  return Math.max(0, Math.min(0.95, open / (width * 0.25))) * glarePenalty;
}
export class VisionEngine {
  private detector: {
    detect(
      image: ImageData,
    ): { id: number; corners: Point[]; hammingDistance: number }[];
  };
  private face: FaceLandmarker;
  private constructor(
    detector: VisionEngine["detector"],
    face: FaceLandmarker,
  ) {
    this.detector = detector;
    this.face = face;
  }
  static async create(config: ScanConfig) {
    const aruco = (await import("js-aruco2")).default;
    const files = await FilesetResolver.forVisionTasks(
      "/scan-fit-runtime/wasm",
    );
    const response = await fetch("/scan-fit-runtime/face_landmarker.task", {
      method: "HEAD",
    });
    if (!response.ok)
      throw Error(
        "The on-device vision model has not been installed. Ask your administrator to complete Scan Fit setup.",
      );
    const face = await FaceLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: "/scan-fit-runtime/face_landmarker.task",
        delegate: "CPU",
      },
      runningMode: "IMAGE",
      numFaces: 1,
      minFaceDetectionConfidence: config.minPupilQuality,
      minFacePresenceConfidence: config.minPupilQuality,
      minTrackingConfidence: config.minPupilQuality,
      outputFacialTransformationMatrixes: true,
    });
    return new VisionEngine(
      new aruco.AR.Detector({
        dictionaryName: "ARUCO_MIP_36h12",
        maxHammingDistance: 1,
      }),
      face,
    );
  }
  analyse(
    canvas: HTMLCanvasElement,
    profile: FrameProfile,
    config: ScanConfig,
  ): AnalysedFrame {
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const markers = this.detector
      .detect(image)
      .filter((m) => profile.markers.some((p) => p.id === m.id))
      .slice(0, 6);
    const detection = this.face.detect(canvas),
      landmarks = detection.faceLandmarks[0];
    const pixel = (p: NormalizedLandmark) => ({
      x: p.x * canvas.width,
      y: p.y * canvas.height,
    });
    const observation: Observation = {
      width: canvas.width,
      height: canvas.height,
      capturedAt: new Date().toISOString(),
      markers,
      pupils: landmarks?.[473]
        ? { right: pixel(landmarks[468]), left: pixel(landmarks[473]) }
        : null,
      faceMidline: landmarks?.[168] ? pixel(landmarks[168]) : null,
      pose: poseFromMatrix(
        detection.facialTransformationMatrixes[0]?.data ?? [],
      ),
      pupilQuality: {
        right: landmarks
          ? irisQuality(
              landmarks,
              468,
              [33, 133],
              [159, 145],
              image,
              config.maxSaturatedFraction,
            )
          : 0,
        left: landmarks
          ? irisQuality(
              landmarks,
              473,
              [362, 263],
              [386, 374],
              image,
              config.maxSaturatedFraction,
            )
          : 0,
      },
      ...imageQuality(image),
    };
    return analyse(observation, profile, config);
  }
  close() {
    this.face.close();
  }
}
export function drawAnnotation(
  context: CanvasRenderingContext2D,
  frame: AnalysedFrame,
  profile: FrameProfile,
) {
  context.save();
  context.strokeStyle = "#16e0b1";
  context.lineWidth = 2;
  for (const marker of frame.observation.markers) {
    context.beginPath();
    marker.corners.forEach((p, i) =>
      i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
    );
    context.closePath();
    context.stroke();
    context.fillStyle = "#16e0b1";
    context.fillText(
      String(marker.id),
      marker.corners[0].x,
      marker.corners[0].y - 5,
    );
  }
  if (frame.homography) {
    const h = inverse(frame.homography),
      a = transform(h, { x: 0, y: profile.bounds.minY }),
      b = transform(h, { x: 0, y: profile.bounds.maxY });
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  for (const [label, p] of Object.entries(frame.observation.pupils ?? {})) {
    context.strokeStyle = label === "right" ? "#ffca68" : "#63beff";
    context.beginPath();
    context.arc(p.x, p.y, 7, 0, Math.PI * 2);
    context.moveTo(p.x - 12, p.y);
    context.lineTo(p.x + 12, p.y);
    context.moveTo(p.x, p.y - 12);
    context.lineTo(p.x, p.y + 12);
    context.stroke();
  }
  context.restore();
}
