import { useState, type ReactNode } from "react";

export function IconImage({ src, fallback }: { src?: string | null; fallback: ReactNode }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return src && src !== failedSrc
    ? <img src={src} alt="" draggable={false} onError={() => setFailedSrc(src)} />
    : fallback;
}
