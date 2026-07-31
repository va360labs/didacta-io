'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { uploadCommunityImage } from '@/lib/community-upload';

/**
 * Iniciales para el fallback del avatar (mismo criterio que /cuenta y el
 * sidebar: 1ª+última palabra del nombre, o las 2 primeras letras del email).
 */
function initialsOf(name: string | null, email: string): string {
  const source = (name ?? email.split('@')[0] ?? '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Widget de subida de avatar. Reutiliza la infra genérica de subida de imágenes
 * (`uploadCommunityImage` → `POST /api/v1/storage/upload`). Devuelve la URL del
 * storage al padre vía `onChange`; persistir en el perfil es responsabilidad
 * del padre (`PATCH /me/profile`).
 */
export function AvatarUpload({
  value,
  onChange,
  name,
  email,
  size = 96,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  name: string | null;
  email: string;
  size?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      // Los avatares se muestran pequeños: 512px basta y ahorra mucho peso.
      const url = await uploadCommunityImage(file, { maxWidth: 512 });
      onChange(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos subir la imagen.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div
        aria-hidden="true"
        className="grid shrink-0 place-items-center overflow-hidden rounded-full font-display font-bold text-white"
        style={{
          height: size,
          width: size,
          fontSize: Math.round(size / 2.8),
          ...(value
            ? {
                backgroundImage: `url(${value})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }
            : { background: 'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)' }),
        }}
      >
        {value ? null : initialsOf(name, email)}
      </div>
      <div className="space-y-1.5">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => void onPick(e.target.files?.[0])}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? 'Subiendo…' : value ? 'Cambiar foto' : 'Subir foto'}
          </Button>
          {value ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={() => onChange(null)}
            >
              Quitar
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-text-subtle">PNG, JPG o WebP. Máx 5 MB.</p>
        {error ? (
          <p role="alert" className="text-xs text-danger-700">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
