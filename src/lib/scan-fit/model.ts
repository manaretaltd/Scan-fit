import { z } from "zod";

export const ALGORITHM_VERSION = "scan-fit/0.1.0";
export const VISION_VERSIONS = {
  faceLandmarker: "0.10.32",
  fiducial: "js-aruco2/2.0.0",
  modelVersion: "1",
  modelSha256:
    "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
} as const;
export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof pointSchema>;
export const markerSchema = z.object({
  id: z.number().int().min(0).max(249),
  corners: z.array(pointSchema).length(4),
});
export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(100),
    version: z.string().trim().min(1).max(40),
    active: z.boolean(),
    marker_type: z.literal("ARUCO_MIP_36h12"),
    markers: z.array(markerSchema).min(4).max(6),
    bounds: z.object({
      minX: z.number().min(-200).max(-10),
      maxX: z.number().min(10).max(200),
      minY: z.number().min(-100).max(0),
      maxY: z.number().min(1).max(100),
    }),
    notes: z.string().max(2000),
  })
  .superRefine((p, ctx) => {
    if (new Set(p.markers.map((m) => m.id)).size !== p.markers.length)
      ctx.addIssue({ code: "custom", message: "Marker IDs must be unique." });
    for (const m of p.markers) {
      const area =
        Math.abs(
          m.corners.reduce(
            (a, c, i) =>
              a +
              c.x * m.corners[(i + 1) % 4].y -
              c.y * m.corners[(i + 1) % 4].x,
            0,
          ),
        ) / 2;
      if (
        area < 1 ||
        m.corners.some((c) => Math.abs(c.x) > 200 || Math.abs(c.y) > 100)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Each marker needs four measured corners with a nonzero area, in millimetres.",
        });
    }
  });
export type FrameProfile = z.infer<typeof profileSchema>;
export const configSchema = z.object({
  version: z.number().int().positive(),
  minMarkers: z.number().int().min(4).max(6),
  burstCount: z.literal(5),
  minValidFrames: z.number().int().min(3).max(5),
  maxYaw: z.number().positive().max(10),
  maxPitch: z.number().positive().max(10),
  maxRoll: z.number().positive().max(10),
  minPupilQuality: z.number().min(0.5).max(1),
  minFrameQuality: z.number().min(0.1).max(1),
  minOverallQuality: z.number().min(0.65).max(1),
  minSharpness: z.number().positive(),
  minBrightness: z.number().min(0).max(120),
  maxBrightness: z.number().min(121).max(255),
  maxSaturatedFraction: z.number().min(0.01).max(0.5),
  maxReprojectionMm: z.number().positive().max(2),
  maxSpreadMm: z.number().positive().max(2),
  maxMidlineMm: z.number().positive().max(10),
  retentionDays: z.number().int().min(1).max(3650),
  captureMinMm: z.number().min(100).max(400),
  captureMaxMm: z.number().min(400).max(1000),
});
export type ScanConfig = z.infer<typeof configSchema>;
export const DEFAULT_CONFIG: ScanConfig = {
  version: 1,
  minMarkers: 4,
  burstCount: 5,
  minValidFrames: 3,
  maxYaw: 3,
  maxPitch: 3,
  maxRoll: 2,
  minPupilQuality: 0.7,
  minFrameQuality: 0.5,
  minOverallQuality: 0.65,
  minSharpness: 25,
  minBrightness: 35,
  maxBrightness: 225,
  maxSaturatedFraction: 0.25,
  maxReprojectionMm: 0.6,
  maxSpreadMm: 0.7,
  maxMidlineMm: 3,
  retentionDays: 90,
  captureMinMm: 390,
  captureMaxMm: 410,
};
export const observationSchema = z.object({
  width: z.number().int().min(100).max(5000),
  height: z.number().int().min(100).max(5000),
  capturedAt: z.string().datetime(),
  markers: z
    .array(
      markerSchema.extend({ hammingDistance: z.number().int().min(0).max(1) }),
    )
    .max(6),
  pupils: z.object({ right: pointSchema, left: pointSchema }).nullable(),
  faceMidline: pointSchema.nullable(),
  pose: z
    .object({
      yaw: z.number().finite(),
      pitch: z.number().finite(),
      roll: z.number().finite(),
    })
    .nullable(),
  pupilQuality: z.object({
    right: z.number().min(0).max(1),
    left: z.number().min(0).max(1),
  }),
  sharpness: z.number().min(0),
  brightness: z.number().min(0).max(255),
  saturatedFraction: z.number().min(0).max(1),
});
export type Observation = z.infer<typeof observationSchema>;
export type Metric = {
  rightPd: number;
  leftPd: number;
  totalPd: number;
  rightX: number;
  leftX: number;
  rightY: number;
  leftY: number;
};
export type AnalysedFrame = {
  observation: Observation;
  valid: boolean;
  reasons: string[];
  homography: number[] | null;
  reprojectionMm: number | null;
  maxReprojectionMm: number | null;
  metric: Metric | null;
  frameQuality: number;
  midlineMm: number | null;
};
export type Aggregate = {
  metric: Metric;
  validFrames: number;
  repeatabilityMm: number;
  spreadMm: number;
  standardDeviationMm: number;
  madMm: number;
  qualityScore: number;
  confidence: "High" | "Medium" | "Low";
  algorithmVersion: string;
  visionVersions: typeof VISION_VERSIONS;
};
export type ScanSession = {
  id: string;
  customer_id: string;
  order_id: string | null;
  operator_id: string;
  status: "Started" | "Review" | "Accepted" | "Repeated" | "Archived";
  profile_snapshot: FrameProfile;
  config_snapshot: ScanConfig;
  device_info: Record<string, unknown>;
  validation_mode: boolean;
  created_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
};
export type StoredFrame = {
  id: string;
  session_id: string;
  frame_index: number;
  observation: Observation;
  analysis: AnalysedFrame;
  original_path: string;
  annotated_path: string;
  rectified_path: string;
  correction: {
    right: Point;
    left: Point;
    reason: string;
    actor: string;
    at: string;
  } | null;
};
export type ScanResult = Aggregate & { manuallyAdjusted: boolean };
export type Reference = {
  method: string;
  rightPd: number;
  leftPd: number;
  totalPd: number;
  rightHeight: number;
  leftHeight: number;
  notes: string;
};
