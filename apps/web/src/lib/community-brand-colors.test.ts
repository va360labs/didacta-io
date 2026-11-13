/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La comunidad va con el COLOR DEL AULA, no con el azul de Didacta.
 *
 * Los chips de etiqueta, las reacciones propias, las menciones, las iniciales
 * de los avatares o el «Start» de la tarjeta de curso salían en el azul fijo
 * (`--didacta-trust`, `--didacta-info-*`, `#1E5AA8`…) en un aula naranja o
 * verde. Este guardián lee el código de esas pantallas y falla si vuelve un
 * azul fijo: los acentos con significado (verde de «en línea» y de los puntos,
 * oro de la medalla, coral del 3.º) no son azules y siguen permitidos.
 *
 * Fuera de la lista, a propósito: `post-composer-modal.tsx` (su selector de
 * espacio lo está cambiando otra rama) y `clase-embed-card.tsx` (su botón
 * «Inscribirme», idem). Cuando se integren, se añaden aquí.
 */

const WEB_SRC = path.resolve(__dirname, '..');

const FILES = [
  'app/(app)/community/page.tsx',
  'app/(app)/community/[id]/page.tsx',
  'app/(app)/community/mentions/page.tsx',
  'components/community-avatar.tsx',
  'components/community-feed.tsx',
  'components/community-gallery-modal.tsx',
  'components/community-powered-by.tsx',
  'components/community-sidebar.tsx',
  'components/community-tag-chip.tsx',
  'components/community-thread-card.tsx',
  'components/community-upcoming-card.tsx',
  'components/course-card.tsx',
  'components/invite-and-earn-card.tsx',
  'components/mention-textarea.tsx',
  'components/post-detail-view.tsx',
  'components/post-reactions.tsx',
  'components/rich-body.tsx',
  'components/user-chip.tsx',
];

/** Azules fijos de Didacta, en cualquiera de sus escrituras. */
const FIXED_BLUE =
  /--didacta-(?:trust|balance|info-fg|info-bg)\b|#1e5aa8\b|#2e7dce\b|rgba\(\s*46\s*,\s*125\s*,\s*206/i;

export function fixedBlueLines(source: string): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => FIXED_BLUE.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

describe('comunidad con el color del aula', () => {
  it.each(FILES)('%s no usa azules fijos de Didacta', (file) => {
    const source = readFileSync(path.join(WEB_SRC, file), 'utf8');
    expect(fixedBlueLines(source)).toEqual([]);
  });

  it('el guardián discrimina: caza cada escritura del azul fijo', () => {
    expect(fixedBlueLines("className='text-[var(--didacta-info-fg)]'")).toHaveLength(1);
    expect(fixedBlueLines("style={{ color: 'var(--didacta-trust)' }}")).toHaveLength(1);
    expect(fixedBlueLines("'linear-gradient(135deg, #1E5AA8 0%, #18B5A8 100%)'")).toHaveLength(1);
    expect(fixedBlueLines("'border-[rgba(46,125,206,0.32)]'")).toHaveLength(1);
    expect(fixedBlueLines("className='bg-brand-50 text-brand-700'")).toEqual([]);
    expect(fixedBlueLines('bg-(--didacta-growth) text-(--didacta-success-fg)')).toEqual([]);
  });
});
