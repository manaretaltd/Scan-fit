/* eslint-disable @next/next/no-img-element -- preserve the supplied logo without optimization or artwork changes */
import { brand } from "@/lib/brand";
export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`elevate-logo ${compact ? "compact" : ""}`}>
      {brand.logoPath ? (
        <img
          src={brand.logoPath}
          alt={brand.name}
          width={brand.logoWidth}
          height={brand.logoHeight}
          className="elevate-logo-image"
        />
      ) : (
        <span className="elevate-wordmark">
          ELEVATE<span>DENTAL OPTICS</span>
        </span>
      )}
    </span>
  );
}
