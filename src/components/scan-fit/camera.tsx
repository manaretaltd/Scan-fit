"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { drawAnnotation, VisionEngine } from "@/lib/scan-fit/vision";
import type { AnalysedFrame, ScanSession } from "@/lib/scan-fit/model";

export function ScanCamera({ session, clientToken, onSubmitted }: { session: ScanSession; clientToken?: string; onSubmitted?: () => void }) {
  const router = useRouter(),
    video = useRef<HTMLVideoElement>(null),
    overlay = useRef<HTMLCanvasElement>(null),
    engine = useRef<VisionEngine | null>(null),
    stream = useRef<MediaStream | null>(null),
    cancel = useRef(false);
  const [started, setStarted] = useState(false),
    [error, setError] = useState(""),
    [live, setLive] = useState<AnalysedFrame | null>(null),
    [progress, setProgress] = useState(0),
    [busy, setBusy] = useState(false),
    [cameraDetails, setCameraDetails] = useState(""),
    [ready, setReady] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]),
    [chosen, setChosen] = useState("");
  const [auto, setAuto] = useState(false),
    aligned = useRef(0);
  const photoCanvas = useRef<HTMLCanvasElement>(null),
    [photoAnalysis, setPhotoAnalysis] = useState<AnalysedFrame | null>(null);
  async function inspectPhoto(file: File) {
    setError("");
    try {
      if (
        !["image/jpeg", "image/png"].includes(file.type) ||
        file.size > 10_485_760
      )
        throw Error("Choose a JPEG or PNG under 10 MB.");
      const bitmap = await createImageBitmap(file),
        canvas = photoCanvas.current!;
      const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas
        .getContext("2d")!
        .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      engine.current ??= await VisionEngine.create(session.config_snapshot);
      const analysis = engine.current.analyse(
        canvas,
        session.profile_snapshot,
        session.config_snapshot,
      );
      setPhotoAnalysis(analysis);
      drawAnnotation(
        canvas.getContext("2d")!,
        analysis,
        session.profile_snapshot,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Photo analysis failed.");
    }
  }
  useEffect(
    () => () => {
      cancel.current = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      engine.current?.close();
    },
    [],
  );
  async function start(deviceId?: string) {
    setError("");
    setStarted(true);
    setReady(false);
    cancel.current = false;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw Error(
          "This device is not currently validated for Elevate Scan Fit. Camera access requires HTTPS and a supported browser.",
        );
      stream.current?.getTracks().forEach((t) => t.stop());
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId
            ? { deviceId: { exact: deviceId } }
            : { facingMode: { ideal: "environment" } }),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      stream.current = media;
      const track = media.getVideoTracks()[0],
        settings = track.getSettings();
      const capabilities = (track.getCapabilities?.() ??
        {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
      if (
        capabilities.zoom &&
        capabilities.zoom.min <= 1 &&
        capabilities.zoom.max >= 1
      )
        await track.applyConstraints({
          advanced: [{ zoom: 1 } as MediaTrackConstraintSet],
        });
      const all = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "videoinput",
      );
      setCameras(all);
      setChosen(settings.deviceId ?? "");
      const rear =
        settings.facingMode === "environment" ||
        /back|rear|environment/i.test(track.label);
      if (
        !rear ||
        /ultra|telephoto/i.test(track.label) ||
        Math.min(settings.width ?? 0, settings.height ?? 0) < 720
      )
        throw Error(
          "This device is not currently validated for Elevate Scan Fit. Select a standard rear camera at sufficient resolution.",
        );
      setCameraDetails(
        `${track.label || "Rear camera"} · ${settings.width} × ${settings.height} · 1× requested`,
      );
      if (!video.current) throw Error("Camera view is unavailable.");
      video.current.srcObject = media;
      await video.current.play();
      engine.current ??= await VisionEngine.create(session.config_snapshot);
      setReady(true);
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Camera permission was denied. Allow camera access in your browser settings and retry."
          : e instanceof Error
            ? e.message
            : "Camera could not start.",
      );
    }
  }
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (
        stopped ||
        busy ||
        !video.current ||
        !overlay.current ||
        !engine.current
      )
        return;
      try {
        const c = captureCanvas(video.current),
          analysis = engine.current.analyse(
            c,
            session.profile_snapshot,
            session.config_snapshot,
          );
        setLive(analysis);
        const o = overlay.current;
        o.width = c.width;
        o.height = c.height;
        const ctx = o.getContext("2d")!;
        ctx.clearRect(0, 0, o.width, o.height);
        drawAnnotation(ctx, analysis, session.profile_snapshot);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Live analysis failed.");
      }
    }, 450);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [ready, busy, session]);
  useEffect(() => {
    if (auto && ready && !busy && live?.valid) {
      aligned.current++;
      if (aligned.current >= 3) {
        aligned.current = 0;
        setAuto(false);
        void capture();
      }
    } else aligned.current = 0;
    // capture uses the current camera and live state; each new analysis is one alignment tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, ready, busy, live]);
  async function capture() {
    if (!live?.valid || !engine.current || !video.current) return;
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      const observations = [],
        files: Blob[] = [];
      for (let i = 0; i < 5; i++) {
        if (cancel.current) throw Error("Capture stopped.");
        const c = captureCanvas(video.current!);
        observations.push(
          engine.current.analyse(
            c,
            session.profile_snapshot,
            session.config_snapshot,
          ).observation,
        );
        files.push(
          await new Promise<Blob>((resolve, reject) =>
            c.toBlob(
              (b) => (b ? resolve(b) : reject(Error("Capture failed."))),
              "image/jpeg",
              0.95,
            ),
          ),
        );
        setProgress(i + 1);
        if (i < 4) await new Promise((r) => setTimeout(r, 350));
      }
      const form = new FormData();
      form.set("session_id", session.id);
      if (clientToken) { form.set("consent", "true"); form.set("consent_version", "remote-capture/1"); }
      form.set("observations", JSON.stringify(observations));
      files.forEach((f, i) => form.set(`image_${i}`, f, `frame-${i}.jpg`));
      const response = await fetch(clientToken ? "/api/client-scan" : "/api/scan-fit", {
          method: "PUT",
          headers: clientToken ? { Authorization: `Bearer ${clientToken}` } : undefined,
          body: form,
        }),
        body = await response.json();
      if (!response.ok) throw Error(body.error || "Burst could not be saved.");
      stream.current?.getTracks().forEach((t) => t.stop());
      setReady(false);
      if (onSubmitted) onSubmitted(); else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Capture failed.");
    } finally {
      setBusy(false);
    }
  }
  const checks = [
    ["Rear camera", ready],
    [
      "Calibrated frame / minimum markers",
      !!live &&
        live.observation.markers.length >= session.config_snapshot.minMarkers,
    ],
    ["Both iris centres", !!live?.observation.pupils],
    [
      "Frame centred",
      live?.midlineMm != null &&
        Math.abs(live.midlineMm) <= session.config_snapshot.maxMidlineMm,
    ],
    [
      "Head alignment",
      !!live?.observation.pose &&
        Math.abs(live.observation.pose.yaw) <= session.config_snapshot.maxYaw &&
        Math.abs(live.observation.pose.pitch) <=
          session.config_snapshot.maxPitch &&
        Math.abs(live.observation.pose.roll) <= session.config_snapshot.maxRoll,
    ],
    [
      "Image sharpness",
      !!live &&
        live.observation.sharpness >= session.config_snapshot.minSharpness,
    ],
    [
      "Lighting / reflections",
      !!live &&
        live.observation.brightness >= session.config_snapshot.minBrightness &&
        live.observation.brightness <= session.config_snapshot.maxBrightness &&
        live.observation.saturatedFraction <=
          session.config_snapshot.maxSaturatedFraction,
    ],
  ] as const;
  return (
    <section className="sf-capture">
      <div className="notice">
        Engineering validation mode. This device has not been validated for
        clinical measurement. Hold the standard rear camera approximately 40 cm
        away (guidance range {session.config_snapshot.captureMinMm}–
        {session.config_snapshot.captureMaxMm} mm); the calibrated frame
        provides scale.
      </div>
      <div className="sf-camera-layout">
        <div
          className="sf-camera-view"
          style={{
            aspectRatio: live
              ? `${live.observation.width}/${live.observation.height}`
              : "3/4",
          }}
        >
          <video
            ref={video}
            playsInline
            muted
            aria-label="Rear camera capture"
          />
          <canvas ref={overlay} className="sf-overlay" />
          <div className="sf-camera-guide" aria-hidden="true" />
          <span className="sf-camera-label">
            ELEVATE SCAN FIT · 40 cm guide
          </span>
        </div>
        <div className="sf-camera-controls">
          <h2>Align the fitting frame</h2>
          <p>
            Portrait orientation, both eyes open, even lighting. Use the normal
            wide camera at 1×, without digital zoom.
          </p>
          <ul className="sf-checks">
            {checks.map(([label, ok]) => (
              <li
                key={label}
                className={live ? (ok ? "sf-ok" : "sf-invalid") : "sf-pending"}
              >
                <span>{ok ? "✓" : "●"}</span>
                {label}
              </li>
            ))}
          </ul>
          <p className="muted">
            Distance: operator guidance only. Browser depth is unavailable.
          </p>
          {cameraDetails && <p className="muted">{cameraDetails}</p>}
          {cameras.length > 1 && (
            <label>
              Camera
              <select
                value={chosen}
                onChange={(e) => void start(e.target.value)}
                disabled={busy}
              >
                {cameras.map((c) => (
                  <option value={c.deviceId} key={c.deviceId}>
                    {c.label || "Camera"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!started || (error && !ready) ? (
            <button className="button" onClick={() => void start()}>
              Check and open rear camera
            </button>
          ) : (
            <button
              className="button"
              disabled={!live?.valid || busy}
              onClick={() => void capture()}
            >
              {busy
                ? `Capturing / saving ${progress} of 5…`
                : "Capture and send my scan"}
            </button>
          )}
          <label className="sf-checkbox">
            <input
              type="checkbox"
              checked={auto}
              disabled={busy || !ready}
              onChange={(e) => setAuto(e.target.checked)}
            />
            Automatically capture after stable alignment
          </label>
          <p className="muted">
            Capture becomes available only when all minimum checks pass.
          </p>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {live && !live.valid && <p role="status">{live.reasons.join(" ")}</p>}
        </div>
      </div>
      {session.validation_mode && (
        <section className="card sf-form" style={{ marginTop: 24 }}>
          <h2>Photo check — detection only</h2>
          <p>
            Inspect a development image locally. A single photo cannot produce
            an accepted burst measurement. Images are not uploaded by this
            check.
          </p>
          <label>
            Development photo
            <input
              type="file"
              accept="image/jpeg,image/png"
              disabled={busy || ready}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void inspectPhoto(file);
              }}
            />
          </label>
          <canvas
            ref={photoCanvas}
            style={{ maxWidth: "100%", height: "auto" }}
          />
          {photoAnalysis && (
            <div role="status">
              <p>
                Detected markers: {photoAnalysis.observation.markers.length} ·
                Both iris centres:{" "}
                {photoAnalysis.observation.pupils ? "detected" : "not detected"}
              </p>
              <p>{photoAnalysis.reasons.join(" ")}</p>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
function captureCanvas(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  const scale = Math.min(
    1,
    960 / Math.max(video.videoWidth, video.videoHeight),
  );
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  if (!canvas.width || !canvas.height) throw Error("Camera is not ready.");
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}
