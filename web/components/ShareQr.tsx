"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** Kod QR z linkiem do oferty — do wklejenia jako zdjęcie w ogłoszeniu. */
export function ShareQr({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<string>();

  useEffect(() => {
    if (!open || src) return;
    QRCode.toDataURL(window.location.href, { margin: 1, width: 320, color: { dark: "#13201B", light: "#FFFFFF" } })
      .then(setSrc)
      .catch(() => setSrc(undefined));
  }, [open, src]);

  return (
    <>
      <button className="btn ghost sm" onClick={() => setOpen((o) => !o)}>
        {open ? "Ukryj kod QR" : "Kod QR do ogłoszenia"}
      </button>
      {open && src && (
        <div className="qr">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={`Kod QR z linkiem do oferty #${id}`} width={160} height={160} />
          <a className="btn ghost sm" href={src} download={`safedeal-oferta-${id}.png`}>
            Pobierz PNG
          </a>
        </div>
      )}
    </>
  );
}
