'use client';

/// Banner discreto en el footer del sidebar que avisa al operador de una
/// versión nueva publicada en Docker Hub. Polling cada 4h con cache en
/// localStorage; el descarte es por versión exacta (cuando salga una más
/// nueva, el banner reaparece).
///
/// Diseño: vive PEGADO al footer "Didacta <version>" del sidebar para no
/// robarle espacio al canvas principal. Una sola línea con CTA "Ver"
/// (abre el changelog en una pestaña nueva, hoy hub.docker.com de la
/// versión nueva) y "X" para descartar.

import { useEffect, useState } from 'react';
import { checkForUpdate, dismissVersion, type VersionCheckResult } from '@/lib/version-check';

export function VersionUpdateBanner() {
  const [check, setCheck] = useState<VersionCheckResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((res) => {
      if (!cancelled) setCheck(res);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!check?.hasUpdate || !check.latest) return null;

  const tag = check.latest.raw;
  const releaseUrl = `https://hub.docker.com/r/didactaio/community/tags?name=${encodeURIComponent(
    tag,
  )}`;

  return (
    <div className="border-t border-amber-400/20 bg-amber-400/[0.08] px-4 py-2 text-[11px] text-amber-100">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate">
          <strong>Nueva versión:</strong>{' '}
          <span className="font-mono">{tag}</span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-amber-400/[0.16] px-1.5 py-0.5 text-amber-100 hover:bg-amber-400/[0.25]"
          >
            Ver
          </a>
          <button
            type="button"
            onClick={() => {
              dismissVersion(tag);
              setCheck((c) => (c ? { ...c, hasUpdate: false } : c));
            }}
            aria-label="Descartar aviso de versión nueva"
            className="rounded px-1 text-amber-200/60 hover:text-amber-100"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
