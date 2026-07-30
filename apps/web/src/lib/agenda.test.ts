import { describe, expect, it } from 'vitest';
import {
  buildGrid,
  dateKeyOf,
  gridRange,
  phaseOf,
  toItems,
  GRID_CELLS,
  type CalendarItem,
} from './agenda';
import type { CommunityEvent } from './events';
import type { ZoomSession } from '@/modules/zoom-live';

function sessionFixture(over: Partial<ZoomSession> = {}): ZoomSession {
  return {
    id: 's1',
    tenantId: 't1',
    courseId: null,
    lessonId: null,
    topic: 'Masterclass de agentes de voz',
    description: null,
    status: 'SCHEDULED',
    startTime: '2026-08-03T14:00:00.000Z',
    durationMinutes: 90,
    timezone: 'Europe/Madrid',
    hostEmail: 'valen@va360labs.com',
    zoomMeetingId: '123',
    joinUrl: null,
    recordingUrl: null,
    recordingDurationMinutes: null,
    registeredCount: 0,
    isRegistered: false,
    createdAt: '2026-07-30T09:00:00.000Z',
    updatedAt: '2026-07-30T09:00:00.000Z',
    ...over,
  };
}

function eventFixture(over: Partial<CommunityEvent> = {}): CommunityEvent {
  return {
    id: 'e1',
    title: 'Taller de prompts',
    description: null,
    location: null,
    startAt: '2026-08-05T16:00:00.000Z',
    endAt: '2026-08-05T17:00:00.000Z',
    capacity: null,
    registeredCount: 0,
    isFull: false,
    isRegistered: false,
    ...over,
  };
}

describe('buildGrid', () => {
  it('siempre da 42 celdas con fecha real, también las del mes vecino', () => {
    const cells = buildGrid(2026, 6); // julio 2026
    expect(cells).toHaveLength(GRID_CELLS);
    expect(cells.every((c) => c.date instanceof Date)).toBe(true);
  });

  it('empieza en lunes y marca correctamente qué celdas son del mes visible', () => {
    // 1 de julio de 2026 es miércoles → la rejilla arranca el lunes 29 de junio.
    const cells = buildGrid(2026, 6);
    expect(dateKeyOf(cells[0]!.date)).toBe('2026-06-29');
    expect(cells[0]!.currentMonth).toBe(false);
    expect(dateKeyOf(cells[2]!.date)).toBe('2026-07-01');
    expect(cells[2]!.currentMonth).toBe(true);
    expect(cells.filter((c) => c.currentMonth)).toHaveLength(31);
  });

  it('el pie de la rejilla de julio incluye el lunes 3 de agosto (el bug reportado)', () => {
    const cells = buildGrid(2026, 6);
    const agosto3 = cells.find((c) => dateKeyOf(c.date) === '2026-08-03');
    expect(agosto3).toBeDefined();
    expect(agosto3!.currentMonth).toBe(false);
  });

  it('un mes que empieza en lunes no arrastra la semana anterior', () => {
    // 1 de junio de 2026 es lunes.
    const cells = buildGrid(2026, 5);
    expect(dateKeyOf(cells[0]!.date)).toBe('2026-06-01');
    expect(cells[0]!.currentMonth).toBe(true);
  });

  it('cruza el año sin romperse', () => {
    const cells = buildGrid(2026, 11); // diciembre 2026
    expect(dateKeyOf(cells[GRID_CELLS - 1]!.date)).toBe('2027-01-10');
  });
});

describe('gridRange', () => {
  it('cubre desde la primera celda hasta el final de la última', () => {
    const { from, to } = gridRange(buildGrid(2026, 6));
    expect(dateKeyOf(from)).toBe('2026-06-29');
    expect(from.getHours()).toBe(0);
    expect(dateKeyOf(to)).toBe('2026-08-09');
    expect(to.getHours()).toBe(23);
  });

  it('el rango pedido contiene la clase del 3 de agosto vista desde julio', () => {
    const { from, to } = gridRange(buildGrid(2026, 6));
    const clase = new Date('2026-08-03T14:00:00.000Z');
    expect(clase >= from && clase <= to).toBe(true);
  });
});

describe('toItems', () => {
  it('mezcla eventos y clases ordenados por fecha de inicio', () => {
    const items = toItems([eventFixture()], [sessionFixture()]);
    expect(items.map((i) => i.kind)).toEqual(['clase', 'evento']);
  });

  it('descarta las clases canceladas', () => {
    const items = toItems([], [sessionFixture({ status: 'CANCELLED' })]);
    expect(items).toEqual([]);
  });

  it('deriva endAt de la duración de la clase', () => {
    const [clase] = toItems([], [sessionFixture({ durationMinutes: 90 })]);
    expect(clase!.endAt).toBe('2026-08-03T15:30:00.000Z');
  });
});

describe('phaseOf', () => {
  const base: CalendarItem = {
    key: 'clase-s1',
    kind: 'clase',
    id: 's1',
    title: 'Masterclass',
    startAt: '2026-08-03T14:00:00.000Z',
    endAt: '2026-08-03T15:30:00.000Z',
    isRegistered: false,
    location: null,
    status: 'SCHEDULED',
    href: '/clase/s1',
  };
  const t = (iso: string) => new Date(iso).getTime();

  it('clasifica por reloj cuando no hay estado de Zoom', () => {
    expect(phaseOf({ ...base, status: null }, t('2026-07-30T10:00:00Z'))).toBe('proxima');
    expect(phaseOf({ ...base, status: null }, t('2026-08-03T14:30:00Z'))).toBe('curso');
    expect(phaseOf({ ...base, status: null }, t('2026-08-04T10:00:00Z'))).toBe('pasada');
  });

  it('ENDED es pasada aunque la ventana teórica siga abierta', () => {
    expect(phaseOf({ ...base, status: 'ENDED' }, t('2026-08-03T14:30:00Z'))).toBe('pasada');
  });

  it('STARTED espurio en el futuro no se anuncia como en directo', () => {
    expect(phaseOf({ ...base, status: 'STARTED' }, t('2026-07-30T10:00:00Z'))).toBe('proxima');
  });

  it('STARTED deja de ser en curso pasado el margen de gracia', () => {
    expect(phaseOf({ ...base, status: 'STARTED' }, t('2026-08-03T17:00:00Z'))).toBe('curso');
    expect(phaseOf({ ...base, status: 'STARTED' }, t('2026-08-03T18:00:00Z'))).toBe('pasada');
  });
});
