/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * El asistente de bienvenida según el modo de cobro (E8 de cobros de
 * plataforma): en Didacta Cloud el paso de cobros conecta sin claves y el de
 * correo desaparece; en el resto, todo como siempre. Y, en los dos modos,
 * cada sitio al que manda el asistente es una página que existe.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ajustarAlModo,
  cobrosConectados,
  destinos,
  DESTINOS,
  ONBOARDING_STEPS,
  onboardingSteps,
  pasosContables,
  paymentsSetupOf,
  tarjetaDeCobros,
  VACIO,
  type OnboardingProgress,
  type PaymentsSetup,
} from './academy';

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/web/src/lib
const APP_DIR = join(HERE, '..', 'app');
const BIENVENIDA_DIR = join(APP_DIR, 'welcome');

describe('modo de cobro del asistente', () => {
  it('solo `mode: platform` es modo plataforma; null, own, none y nada son el de siempre', () => {
    expect(paymentsSetupOf({ mode: 'platform' })).toBe('platform');
    expect(paymentsSetupOf({ mode: 'own' })).toBe('own');
    expect(paymentsSetupOf({ mode: 'none' })).toBe('own');
    expect(paymentsSetupOf(null)).toBe('own');
    expect(paymentsSetupOf(undefined)).toBe('own');
  });

  it('plataforma: tarjeta de conectar y SIN paso de correo', () => {
    expect(tarjetaDeCobros('platform')).toBe('conectar');
    const pasos = onboardingSteps('platform');
    expect(pasos).not.toContain('correo');
    expect(pasos).toEqual([
      'bienvenida',
      'nombre',
      'marca',
      'curso',
      'alumnos',
      'cobros',
      'resumen',
    ]);
    expect(pasosContables('platform')).toBe(5);
    expect(destinos('platform')).not.toHaveProperty('correo');
    expect(destinos('platform').cobros).toBe('/admin/payments');
  });

  it('own / sin plataforma: tarjeta de claves, con correo, exactamente como antes', () => {
    expect(tarjetaDeCobros('own')).toBe('claves');
    expect(onboardingSteps('own')).toEqual([...ONBOARDING_STEPS]);
    expect(pasosContables('own')).toBe(6);
    expect(destinos('own')).toEqual(DESTINOS);
  });

  it('el paso de cobros en plataforma queda resuelto solo si está lista o en revisión', () => {
    expect(cobrosConectados({ kind: 'ready' })).toBe(true);
    expect(cobrosConectados({ kind: 'review' })).toBe(true);
    for (const kind of ['not-connected', 'missing', 'rejected', 'country-unsupported']) {
      expect(cobrosConectados({ kind })).toBe(false);
    }
  });
});

describe('progreso guardado y modo actual', () => {
  const guardado = (p: Partial<OnboardingProgress>): OnboardingProgress => ({ ...VACIO, ...p });

  it('un `step: correo` guardado lleva en plataforma al siguiente paso válido (resumen)', () => {
    const ajustado = ajustarAlModo(
      guardado({ step: 'correo', done: ['nombre', 'marca', 'cobros'] }),
      'platform',
    );
    expect(ajustado.step).toBe('resumen');
    expect(onboardingSteps('platform')).toContain(ajustado.step);
  });

  it('en plataforma `correo` sale de done y skipped (ni cuenta ni queda pendiente)', () => {
    const ajustado = ajustarAlModo(
      guardado({ step: 'cobros', done: ['nombre', 'correo'], skipped: ['correo', 'curso'] }),
      'platform',
    );
    expect(ajustado.done).toEqual(['nombre']);
    expect(ajustado.skipped).toEqual(['curso']);
    expect(ajustado.step).toBe('cobros');
  });

  it('en own el progreso no se toca, `correo` incluido', () => {
    const p = guardado({ step: 'correo', done: ['correo'], skipped: ['cobros'] });
    expect(ajustarAlModo(p, 'own')).toEqual(p);
  });

  it('cualquier paso guardado acaba en un paso que existe en cada modo', () => {
    for (const setup of ['platform', 'own'] as const) {
      for (const step of ONBOARDING_STEPS) {
        expect(onboardingSteps(setup)).toContain(ajustarAlModo(guardado({ step }), setup).step);
      }
    }
  });
});

// ── Los destinos del asistente son rutas que existen ──────────────────────────

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pageFiles(abs));
    else if (entry.name === 'page.tsx') out.push(abs);
  }
  return out;
}

/** page.tsx → regex de su ruta: sin grupos `(…)` ni slots `@…`, con dinámicos. */
function routeMatcher(absPage: string): RegExp {
  const rel = absPage
    .slice(APP_DIR.length)
    .split(sep)
    .join('/')
    .replace(/\/page\.tsx$/, '');
  const segments = rel.split('/').filter((s) => s && !/^\(.+\)$/.test(s) && !s.startsWith('@'));
  let pattern = '';
  for (const s of segments) {
    if (/^\[\[\.\.\..+\]\]$/.test(s)) pattern += '(?:/.*)?';
    else if (/^\[\.\.\..+\]$/.test(s)) pattern += '/.+';
    else if (/^\[.+\]$/.test(s)) pattern += '/[^/]+';
    else pattern += '/' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern || '/'}$`);
}

const RUTAS = pageFiles(APP_DIR).map(routeMatcher);

function existe(destino: string): boolean {
  const path = destino.split(/[?#]/)[0]!;
  return RUTAS.some((re) => re.test(path));
}

/**
 * Rutas literales a las que navega el código del asistente (`href`,
 * `router.replace/push`). Un `${…}` cuenta como un segmento dinámico.
 */
function rutasDelCodigo(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(BIENVENIDA_DIR)) {
    if (!/\.tsx?$/.test(f) || f.includes('.test.')) continue;
    const src = readFileSync(join(BIENVENIDA_DIR, f), 'utf8');
    for (const m of src.matchAll(/(?:href=\{?|replace\(|push\()\s*[`'"](\/[^`'"]*)[`'"]/g)) {
      out.add(m[1]!.replace(/\$\{[^}]+\}/g, 'x'));
    }
  }
  return [...out];
}

describe('los destinos del asistente son rutas que existen', () => {
  it('el comprobador de rutas funciona (resuelve grupos y dinámicos, y rechaza inventadas)', () => {
    expect(existe('/admin/payments')).toBe(true); // vive en (app)
    expect(existe('/studio/courses/abc')).toBe(true); // [id]
    expect(existe('/admin/settings?tab=pagos')).toBe(true);
    expect(existe('/admin/billing-inventado')).toBe(false);
  });

  for (const setup of ['platform', 'own'] satisfies PaymentsSetup[]) {
    it(`destinos en modo ${setup}`, () => {
      const rotos = Object.entries(destinos(setup)).filter(([, d]) => !existe(d!));
      expect(rotos, 'destinos del asistente sin page.tsx (404)').toEqual([]);
    });
  }

  it('enlaces y redirecciones escritos en el código del asistente', () => {
    const rutas = rutasDelCodigo();
    // Que el escaneo encuentre algo: si no, el test pasaría sin mirar nada.
    expect(rutas).toEqual(expect.arrayContaining(['/signin', '/home']));
    expect(rutas.filter((r) => !existe(r))).toEqual([]);
  });
});
