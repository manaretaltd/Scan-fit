// Artificial geometry for numerical/security tests. Never a physical calibration.
import { transform } from "../src/lib/scan-fit/geometry";
import type { FrameProfile, Observation } from "../src/lib/scan-fit/model";
export const syntheticProfile: FrameProfile = {
  name: "SYNTHETIC TEST FRAME",
  model: "test-only",
  version: "1",
  active: true,
  marker_type: "ARUCO_MIP_36h12",
  markers: [
    [-70, 35],
    [64, 35],
    [-70, -4],
    [64, -4],
  ].map(([x, y], id) => ({
    id,
    corners: [
      { x, y },
      { x: x + 6, y },
      { x: x + 6, y: y - 6 },
      { x, y: y - 6 },
    ],
  })),
  bounds: { minX: -80, maxX: 80, minY: -10, maxY: 55 },
  notes: "Artificial coordinates; not for physical measurement.",
};
export const metricToImage = [
  4.5, 0.12, 400, 0.08, -4.5, 300, 0.00015, 0.0001, 1,
];
export function syntheticObservation(offset = 0): Observation {
  return {
    width: 800,
    height: 600,
    capturedAt: new Date(
      Date.UTC(2026, 9, 13, 12, 0, 0) + offset * 350,
    ).toISOString(),
    markers: syntheticProfile.markers.map((m) => ({
      ...m,
      corners: m.corners.map((p) => transform(metricToImage, p)),
      hammingDistance: 0,
    })),
    pupils: {
      right: transform(metricToImage, { x: -32 + offset * 0.015, y: 20 }),
      left: transform(metricToImage, { x: 31 + offset * 0.015, y: 21 }),
    },
    faceMidline: transform(metricToImage, { x: 0, y: 25 }),
    pose: { yaw: 0, pitch: 0, roll: 0 },
    pupilQuality: { right: 0.95, left: 0.95 },
    sharpness: 100,
    brightness: 120,
    saturatedFraction: 0.01,
  };
}
