import { describe, expect, it } from 'vitest';
import { computeParticipantEvidence, type LessonEvidence } from '../src/tracking-evidence.js';
import { buildSeguimientoCsv } from '../src/seguimiento-csv.js';

/**
 * Horas Fundae reconstruidas desde el rastro de interacción (LMS-121).
 *
 * El caso que motiva el fichero entero está en el primer test: antes, un alumno
 * que marcaba las 10 lecciones sin abrir ninguna se llevaba las 10 horas
 * completas, porque las horas salían de `horasFormacion × progressPercent / 100`
 * y `progressPercent` contaba casillas.
 */

function lesson(over: Partial<LessonEvidence> & { lessonId: string }): LessonEvidence {
  return {
    lessonTitle: `Lección ${over.lessonId}`,
    moduleTitle: 'Módulo 1',
    position: 1,
    type: 'VIDEO',
    durationMinutes: 60,
    watchedSeconds: 0,
    completed: false,
    completionSource: null,
    firstAccessedAt: null,
    lastAccessedAt: null,
    completedAt: null,
    ...over,
  };
}

describe('computeParticipantEvidence (LMS-121)', () => {
  it('marcar las 10 lecciones sin abrir ninguna deja las horas donde estaban: en nada verificado', () => {
    const lessons = Array.from({ length: 10 }, (_, i) =>
      lesson({
        lessonId: `l-${i}`,
        position: i + 1,
        durationMinutes: 60,
        watchedSeconds: 0,
        completed: true,
        completionSource: 'SELF',
      }),
    );

    const ev = computeParticipantEvidence(lessons, 10, 100);

    // Las horas se siguen declarando (no borramos el histórico de nadie)...
    expect(ev.horasAsistidas).toBe(10);
    // ...pero el paquete de auditoría dice, sin ambigüedad, que las 10 son
    // autodeclaradas. Es la diferencia entre exportar un número y poder
    // sostenerlo delante de un inspector.
    expect(ev.horasSinVerificar).toBe(10);
    expect(ev.leccionesVerificadas).toBe(0);
    expect(ev.segundosRegistrados).toBe(0);
  });

  it('una lección verificada aporta su duración completa aunque el tiempo visto sea 0', () => {
    // Es el caso de un cuestionario: el puente de evaluaciones lo cierra con
    // `watchedSeconds: 0`. Contar solo tiempo visto dejaría a cero un curso
    // hecho de cuestionarios.
    const ev = computeParticipantEvidence(
      [
        lesson({
          lessonId: 'q1',
          type: 'QUIZ',
          durationMinutes: 30,
          watchedSeconds: 0,
          completed: true,
          completionSource: 'ASSESSMENT',
        }),
      ],
      0.5,
      100,
    );

    expect(ev.horasAsistidas).toBe(0.5);
    expect(ev.horasSinVerificar).toBe(0);
    expect(ev.actividadesTotales).toBe(1);
    expect(ev.actividadesSuperadas).toBe(1);
    expect(ev.pctActividades).toBe(100);
  });

  it('sin respaldo, la lección aporta solo el tiempo REALMENTE registrado', () => {
    const ev = computeParticipantEvidence(
      [
        lesson({
          lessonId: 'l-1',
          durationMinutes: 60,
          watchedSeconds: 900, // 15 min de 60
          completed: false,
        }),
      ],
      1,
      0,
    );

    expect(ev.horasAsistidas).toBe(0.25);
    expect(ev.leccionesIniciadas).toBe(1);
    expect(ev.leccionesCompletadas).toBe(0);
  });

  it('una pestaña olvidada toda la noche no vale 8 horas: el tope es la duración', () => {
    const ev = computeParticipantEvidence(
      [lesson({ lessonId: 'l-1', durationMinutes: 60, watchedSeconds: 8 * 3600 })],
      1,
      0,
    );

    expect(ev.horasAsistidas).toBe(1);
    expect(ev.segundosRegistrados).toBe(8 * 3600);
  });

  it('nunca se declaran más horas de las que la acción comunicó a Fundae', () => {
    // Cuatro lecciones de 1 h en una acción declarada de 2 h: el total se topa.
    const lessons = Array.from({ length: 4 }, (_, i) =>
      lesson({
        lessonId: `l-${i}`,
        durationMinutes: 60,
        watchedSeconds: 3600,
        completed: true,
        completionSource: 'TIME',
      }),
    );

    const ev = computeParticipantEvidence(lessons, 2, 100);
    expect(ev.horasAsistidas).toBe(2);
    expect(ev.pctHoras).toBe(100);
  });

  it('las lecciones sin duración declarada reparten las horas de la acción a partes iguales', () => {
    const lessons = [
      lesson({ lessonId: 'l-0', durationMinutes: null, completed: true, completionSource: 'TIME' }),
      lesson({ lessonId: 'l-1', durationMinutes: null }),
      lesson({ lessonId: 'l-2', durationMinutes: null }),
      lesson({ lessonId: 'l-3', durationMinutes: null }),
    ];

    const ev = computeParticipantEvidence(lessons, 8, 25);
    expect(ev.horasAsistidas).toBe(2);
  });

  it('el % de horas y el de actividades se calculan por separado — son los dos criterios de la instrucción', () => {
    const lessons = [
      // 3 h de vídeo hechas con permanencia comprobada…
      ...Array.from({ length: 3 }, (_, i) =>
        lesson({
          lessonId: `v-${i}`,
          durationMinutes: 60,
          watchedSeconds: 3600,
          completed: true,
          completionSource: 'TIME',
        }),
      ),
      // …pero solo 1 de los 2 cuestionarios superado.
      lesson({
        lessonId: 'q-0',
        type: 'QUIZ',
        durationMinutes: 30,
        completed: true,
        completionSource: 'ASSESSMENT',
      }),
      lesson({ lessonId: 'q-1', type: 'QUIZ', durationMinutes: 30 }),
    ];

    const ev = computeParticipantEvidence(lessons, 4, 80);

    expect(ev.pctHoras).toBe(87.5); // 3,5 h de 4
    expect(ev.pctActividades).toBe(50); // 1 de 2 — por debajo del 75 % exigido
    expect(ev.actividadesSuperadas).toBe(1);
    expect(ev.actividadesTotales).toBe(2);
  });

  it('un curso sin actividades no queda suspenso por no tenerlas', () => {
    const ev = computeParticipantEvidence([lesson({ lessonId: 'l-0' })], 1, 0);
    expect(ev.actividadesTotales).toBe(0);
    expect(ev.pctActividades).toBe(100);
  });

  it('primer y último acceso son los extremos de todo el itinerario', () => {
    const ev = computeParticipantEvidence(
      [
        lesson({
          lessonId: 'l-0',
          firstAccessedAt: new Date('2026-03-05T10:00:00Z'),
          lastAccessedAt: new Date('2026-03-06T10:00:00Z'),
        }),
        lesson({
          lessonId: 'l-1',
          firstAccessedAt: new Date('2026-03-01T10:00:00Z'),
          lastAccessedAt: new Date('2026-03-09T10:00:00Z'),
        }),
      ],
      2,
      0,
    );

    expect(ev.primerAccesoAt?.toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(ev.ultimoAccesoAt?.toISOString()).toBe('2026-03-09T10:00:00.000Z');
  });

  it('conserva la fórmula antigua en un campo aparte, para poder explicar el salto', () => {
    const ev = computeParticipantEvidence(
      [lesson({ lessonId: 'l-0', durationMinutes: 60 })],
      10,
      90,
    );
    expect(ev.horasDeclaradasPorProgreso).toBe(9);
    expect(ev.horasAsistidas).toBe(0);
  });

  it('sin lecciones (acción sin curso asociado) no inventa horas', () => {
    const ev = computeParticipantEvidence([], 10, 50);
    expect(ev.horasAsistidas).toBe(0);
    expect(ev.leccionesTotales).toBe(0);
    expect(ev.horasDeclaradasPorProgreso).toBe(5);
  });
});

describe('buildSeguimientoCsv (LMS-121)', () => {
  it('saca una fila por lección con el origen del completado', () => {
    const csv = buildSeguimientoCsv([
      {
        nifAlumno: '12345678Z',
        email: 'juan@x.com',
        nombre: 'Juan',
        orden: 1,
        moduloTitulo: 'Módulo 1',
        leccionTitulo: 'Introducción',
        tipo: 'VIDEO',
        duracionMinutos: 30,
        primerAccesoAt: new Date('2026-03-01T09:00:00Z'),
        ultimoAccesoAt: new Date('2026-03-01T09:31:00Z'),
        segundosRegistrados: 1860,
        completada: true,
        completadaAt: new Date('2026-03-01T09:31:00Z'),
        origenCompletado: 'TIME',
        verificada: true,
      },
      {
        nifAlumno: '12345678Z',
        email: 'juan@x.com',
        nombre: 'Juan',
        orden: 2,
        moduloTitulo: 'Módulo 1',
        leccionTitulo: 'Test final',
        tipo: 'QUIZ',
        duracionMinutos: null,
        primerAccesoAt: null,
        ultimoAccesoAt: null,
        segundosRegistrados: 0,
        completada: false,
        completadaAt: null,
        origenCompletado: null,
        verificada: false,
      },
    ]);

    expect(csv).toContain(
      'nif,email,nombre,orden,modulo,leccion,tipo,duracion_min,primer_acceso,ultimo_acceso,segundos_registrados,completada,fecha_completado,origen_completado,verificada',
    );
    expect(csv).toContain(
      '12345678Z,juan@x.com,Juan,1,Módulo 1,Introducción,VIDEO,30,2026-03-01T09:00:00.000Z,2026-03-01T09:31:00.000Z,1860,SI,2026-03-01T09:31:00.000Z,TIME,SI',
    );
    expect(csv).toContain('12345678Z,juan@x.com,Juan,2,Módulo 1,Test final,QUIZ,,,,0,NO,,,NO');
  });

  it('escapa comas y comillas del título, y abre bien en Excel (BOM + CRLF)', () => {
    const csv = buildSeguimientoCsv([
      {
        nifAlumno: null,
        email: 'a@x.com',
        nombre: null,
        orden: 1,
        moduloTitulo: 'M1',
        leccionTitulo: 'Cómo, y por qué, "medir"',
        tipo: 'TEXT',
        duracionMinutos: null,
        primerAccesoAt: null,
        ultimoAccesoAt: null,
        segundosRegistrados: 0,
        completada: false,
        completadaAt: null,
        origenCompletado: null,
        verificada: false,
      },
    ]);

    expect(csv).toContain('"Cómo, y por qué, ""medir"""');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
  });
});
