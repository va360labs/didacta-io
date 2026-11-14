import { describe, expect, it } from 'vitest';
import {
  addDays,
  celebrationLocale,
  computeStreak,
  escapeMd,
  hasReached,
  liveStreak,
  localDay,
  numberLevels,
  pointsMissing,
  renderCelebration,
  weekStart,
} from '../src/retention.logic.js';

// ============================================================================
// Reglas puras de la retención: el día local de cada persona, la racha (sin
// castigo: no se rompe hasta pasar un día entero sin actividad), el número de
// nivel, si un cierre está abierto y el texto de las celebraciones agrupadas.
// ============================================================================

describe('localDay — el día de actividad es el de la persona, no el del servidor', () => {
  it('las 23:30 de Madrid siguen siendo ese día aunque en UTC sea el siguiente… y al revés en Brasil', () => {
    const at = new Date('2026-11-14T22:30:00Z'); // 23:30 en Madrid (UTC+1)
    expect(localDay(at, 'Europe/Madrid')).toBe('2026-11-14');
    const late = new Date('2026-11-15T01:30:00Z'); // 22:30 del 14 en São Paulo (UTC-3)
    expect(localDay(late, 'America/Sao_Paulo')).toBe('2026-11-14');
    expect(localDay(late, 'UTC')).toBe('2026-11-15');
  });

  it('una zona mal escrita en el perfil no pierde la actividad: cae a UTC', () => {
    expect(localDay(new Date('2026-11-14T10:00:00Z'), 'Mars/Olympus')).toBe('2026-11-14');
  });
});

describe('computeStreak — días y semanas seguidos', () => {
  it('cuenta la última racha y la mejor, sin importar orden ni repetidos', () => {
    const days = [
      '2026-11-10',
      '2026-11-03',
      '2026-11-04',
      '2026-11-11',
      '2026-11-12',
      '2026-11-12',
      '2026-11-05',
    ];
    const s = computeStreak(days);
    expect(s.runDays).toBe(3); // 10, 11, 12
    expect(s.bestDays).toBe(3); // 3-5 y 10-12
    expect(s.lastDay).toBe('2026-11-12');
  });

  it('las semanas van de lunes a domingo y basta un día por semana', () => {
    // 2026-11-02 es lunes. Semanas: 26-oct (dom 1-nov), 2-nov, 9-nov → 3 seguidas.
    const s = computeStreak(['2026-11-01', '2026-11-08', '2026-11-09']);
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
    expect(s.runWeeks).toBe(3);
    expect(s.runDays).toBe(2);
  });

  it('sin actividad, todo a cero', () => {
    expect(computeStreak([])).toEqual({
      runDays: 0,
      bestDays: 0,
      runWeeks: 0,
      bestWeeks: 0,
      lastDay: null,
    });
  });
});

describe('liveStreak — reglas claras y sin castigo', () => {
  const stored = { runDays: 5, runWeeks: 2, lastDay: '2026-11-13' };

  it('hoy todavía no ha hecho nada: la racha de ayer sigue viva', () => {
    expect(liveStreak(stored, '2026-11-14')).toEqual({
      currentDays: 5,
      currentWeeks: 2,
      activeToday: false,
    });
  });

  it('activo hoy → racha viva y marcada', () => {
    expect(liveStreak({ ...stored, lastDay: '2026-11-14' }, '2026-11-14').activeToday).toBe(true);
  });

  it('un día entero sin actividad rompe la racha diaria, pero no la semanal de esta semana', () => {
    // 13-nov es viernes; el domingo 15 ya pasó el sábado entero sin nada.
    const live = liveStreak(stored, '2026-11-15');
    expect(live.currentDays).toBe(0);
    expect(live.currentWeeks).toBe(2);
  });

  it('una semana entera sin actividad rompe la semanal', () => {
    expect(liveStreak(stored, addDays('2026-11-13', 14)).currentWeeks).toBe(0);
  });
});

describe('niveles y cierres', () => {
  const levels = numberLevels([
    { id: 'b', key: 'pro', name: 'Pro', minPoints: 300 },
    { id: 'a', key: 'novato', name: 'Novato', minPoints: 0 },
    { id: 'c', key: 'master', name: 'Máster', minPoints: 1000 },
  ]);

  it('el nivel N es el puesto por puntos (1 = el más bajo)', () => {
    expect(levels.map((l) => [l.key, l.number])).toEqual([
      ['novato', 1],
      ['pro', 2],
      ['master', 3],
    ]);
  });

  it('se abre por puntos o por el nivel ya alcanzado (el nivel no se retira)', () => {
    const pro = levels[1]!;
    expect(hasReached(pro, { lifetimePoints: 300, currentLevelMinPoints: null })).toBe(true);
    expect(hasReached(pro, { lifetimePoints: 299, currentLevelMinPoints: null })).toBe(false);
    // Le revocaron puntos (bajó a 250) pero ya era Pro: lo abierto no se cierra.
    expect(hasReached(pro, { lifetimePoints: 250, currentLevelMinPoints: 300 })).toBe(true);
    expect(pointsMissing(pro, { lifetimePoints: 180, currentLevelMinPoints: 0 })).toBe(120);
    expect(pointsMissing(pro, { lifetimePoints: 250, currentLevelMinPoints: 300 })).toBe(0);
  });
});

describe('renderCelebration — un post por día y tipo, sin spam', () => {
  it('una persona → post personal (sin marcas: lo que se publica es lo que se lee)', () => {
    const r = renderCelebration(
      'course',
      [{ userId: 'u1', name: 'Ana', detail: 'Excel desde cero' }],
      'es',
    );
    expect(r.title).toBe('🎓 ¡Ana ha terminado «Excel desde cero»!');
    expect(r.body).toContain('**Ana**');
    expect(r.body).not.toContain('<!--');
  });

  it('varias el mismo día → UN post que las nombra; más de 12 → «y N más»', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ userId: `u${i}`, name: `Persona ${i}` }));
    const r = renderCelebration('intro', many, 'es');
    expect(r.title).toBe('👋 15 personas se han presentado hoy');
    expect(r.body.match(/^- \*\*/gm)).toHaveLength(12);
    expect(r.body).toContain('- y 3 más');
  });

  it('en inglés y en portugués (pt-BR → pt)', () => {
    expect(
      renderCelebration('level', [{ userId: 'u', name: 'Ana', detail: 'Pro' }], 'en').title,
    ).toBe('⭐ Ana reached level Pro');
    expect(celebrationLocale('pt-BR')).toBe('pt');
    expect(celebrationLocale('en-US')).toBe('en');
    expect(celebrationLocale(null)).toBe('es');
    const pt = renderCelebration('anniversary', [{ userId: 'u', name: 'Ana', detail: '2' }], 'pt');
    expect(pt.title).toBe('🎂 Ana completa 2 anos na comunidade');
  });

  it('un nombre no puede colar formato ni una mención (que avisaría a otra persona)', () => {
    expect(escapeMd('**Ana** @luis [x](https://e.vil)')).toBe('Ana luis x(https://e.vil)');
    const r = renderCelebration('intro', [{ userId: 'u', name: '@todos **hack**' }], 'es');
    expect(r.body).not.toContain('@');
    expect(r.body).toContain('**todos hack**');
  });
});
