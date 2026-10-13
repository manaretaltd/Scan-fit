"use client";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/branding/logo";
import { ScanCamera } from "./camera";
import type { ScanSession } from "@/lib/scan-fit/model";

export function ClientScan() {
  const [token, setToken] = useState(""), [session, setSession] = useState<ScanSession | null>(null), [state, setState] = useState("loading"), [consent, setConsent] = useState(false), [begun, setBegun] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const link = window.location.hash.slice(1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(link)) { queueMicrotask(() => { if (!cancelled) setState("missing"); }); return () => { cancelled = true; }; }
    fetch("/api/client-scan", { method: "POST", headers: { Authorization: `Bearer ${link}` } })
      .then(async r => { if (!r.ok) throw Error("unavailable"); return r.json(); })
      .then(body => { if (!cancelled) { setToken(link); setState(body.state); setSession(body.session ?? null); } })
      .catch(() => { if (!cancelled) setState("unavailable"); });
    return () => { cancelled = true; };
  }, []);
  return <div className="client-shell">
    <header className="client-header"><BrandLogo compact /><span>SCAN FIT · REMOTE FITTING</span></header>
    <section className="client-hero"><span className="eyebrow">ELEVATE DENTAL OPTICS</span><h1>Your fit, from home.</h1><p>A guided scan, sent directly to the Elevate team for review.</p></section>
    {state === "loading" && <p role="status">Opening your measurement link…</p>}
    {state === "missing" && <section className="card"><h2>Your private measurement link</h2><p>Open the link supplied by the Elevate team to start. You do not need an account or password.</p><p>If you have not received a link, contact the team so your scan can be connected to the correct customer record.</p></section>}
    {state === "unavailable" && <section className="card"><h2>This link is unavailable</h2><p>It may have expired or been withdrawn. Contact the Elevate team for a new measurement link.</p></section>}
    {state === "submitted" && <section className="card client-success"><span className="eyebrow">SUBMITTED FOR REVIEW</span><h2>Thank you. Your scan is with Elevate.</h2><p>The images and scan information are attached to your customer record. The team will review them and contact you if another capture is needed.</p><p>No order measurements have been automatically changed.</p></section>}
    {state === "ready" && session && <>
      {!begun ? <section className="card client-instructions"><h2>Before you start</h2>
        <ol><li>Wear the calibrated fitting frame supplied by Elevate. Ordinary glasses cannot replace it.</li><li>Ask someone to help with the standard rear phone camera at 1×, approximately 40 cm away.</li><li>Use even lighting, hold the phone upright, keep your head level and follow the alignment prompts.</li></ol>
        <p className="notice">This is a development measurement workflow. Device support and measurement accuracy are still being validated. Every submission requires review by the Elevate team.</p>
        <label className="sf-checkbox"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I agree to send my fitting images and scan information to Elevate for storage and staff review.</label>
        <button className="button" disabled={!consent} onClick={() => setBegun(true)}>Start my scan</button>
        <p>You will be asked for camera permission. Nothing is submitted until you capture and send the five-frame scan.</p>
      </section> : <ScanCamera session={session} clientToken={token} onSubmitted={() => { setState("submitted"); setSession(null); }} />}
    </>}
    <footer className="client-footer">Elevate Dental Optics · Private client measurement</footer>
  </div>;
}
