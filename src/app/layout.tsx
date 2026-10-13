import type { Metadata } from "next";
import "./globals.css";
import "@/app/client.css";
import "@/app/scan-fit.css";
export const metadata: Metadata = {
  title: "Elevate Scan Fit",
  description: "Your remote Elevate fitting measurement",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en-GB"><body><main id="main">{children}</main></body></html>;
}
