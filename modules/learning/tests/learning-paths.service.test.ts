/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it, vi } from 'vitest';
import { LearningPathsService } from '../src/learning-paths.service';
import { LearningService } from '../src/learning.service';
import { CourseNotFreeError, LearningPathAlreadyEnrolledError } from '../src/errors';

/**
 * Apuntarse a una ruta de aprendizaje NO regala sus cursos.
 *
 * Antes `enrollUser` creaba una matrícula `ADMIN` en cada curso de la ruta sin
 * mirar si se vendía: con una llamada a `POST /modules/learning/paths/:id/enroll`
 * cualquier alumno con sesión entraba gratis en los cursos de pago.
 *
 * Estos tests montan los DOS servicios de verdad (`LearningPathsService` +
 * `LearningService`) sobre un Prisma en memoria y miran lo único que importa:
 * qué matrículas existen al terminar. Probar el servicio de rutas contra un
 * doble de `LearningService` solo comprobaría que se llaman entre sí.
 */

const T = 't-1';
const ALUMNO = 'u-alumno';

interface Curso {
  id: string;
  tenantId: string;
  slug: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED';
  deletedAt: Date | null;
  externalPurchaseUrl: string | null;
}
interface Matricula {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'PAUSED' | 'CANCELLED';
  source: string;
  cancelledAt: Date | null;
}
interface InscripcionRuta {
  id: string;
  tenantId: string;
  pathId: string;
  userId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  progressPercent: number;
  completedAt: Date | null;
}

function mundo(opts: {
  /** Cursos de la ruta, en orden. Publicados y sin compra externa salvo que se diga. */
  cursos: Array<{ id: string; status?: Curso['status']; externalPurchaseUrl?: string | null }>;
  /** Cursos por los que el tenant cobra dentro del aula. */
  aLaVenta?: string[];
  /** Matrículas que el alumno ya tiene. */
  matriculas?: Array<{ courseId: string; status: Matricula['status']; source?: string }>;
  /** Inscripción previa del alumno en la ruta. */
  inscripcion?: InscripcionRuta['status'];
}) {
  const cursos = new Map<string, Curso>(
    opts.cursos.map((c) => [
      c.id,
      {
        id: c.id,
        tenantId: T,
        slug: `slug-${c.id}`,
        title: `Curso ${c.id}`,
        status: c.status ?? 'PUBLISHED',
        deletedAt: null,
        externalPurchaseUrl: c.externalPurchaseUrl ?? null,
      },
    ]),
  );
  let n = 0;
  const matriculas: Matricula[] = (opts.matriculas ?? []).map((m) => ({
    id: `e-${++n}`,
    tenantId: T,
    userId: ALUMNO,
    courseId: m.courseId,
    status: m.status,
    source: m.source ?? 'GROUP',
    cancelledAt: null,
  }));
  const inscripciones: InscripcionRuta[] = opts.inscripcion
    ? [
        {
          id: 'pe-0',
          tenantId: T,
          pathId: 'p-1',
          userId: ALUMNO,
          status: opts.inscripcion,
          progressPercent: 0,
          completedAt: null,
        },
      ]
    : [];
  const aLaVenta = new Set(opts.aLaVenta ?? []);

  const deAlumno = (w: { tenantId: string; userId: string; courseId: string }) =>
    matriculas.find(
      (m) => m.tenantId === w.tenantId && m.userId === w.userId && m.courseId === w.courseId,
    ) ?? null;

  const prisma = {
    modLearningPath: {
      findFirst: vi.fn(async () => ({
        id: 'p-1',
        tenantId: T,
        slug: 'ruta',
        title: 'Ruta',
        description: null,
        sequenceType: 'LINEAR',
        status: 'PUBLISHED',
        estimatedMinutes: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        courses: opts.cursos.map((c, position) => ({
          id: `pc-${c.id}`,
          courseId: c.id,
          position,
        })),
      })),
    },
    modLearningPathEnrollment: {
      findUnique: vi.fn(async () => inscripciones[0] ?? null),
      upsert: vi.fn(async () => {
        if (inscripciones[0]) {
          inscripciones[0].status = 'ACTIVE';
          inscripciones[0].completedAt = null;
        } else {
          inscripciones.push({
            id: 'pe-1',
            tenantId: T,
            pathId: 'p-1',
            userId: ALUMNO,
            status: 'ACTIVE',
            progressPercent: 0,
            completedAt: null,
          });
        }
        return inscripciones[0]!;
      }),
    },
    modLearningEnrollment: {
      findMany: vi.fn(
        async (args: {
          where: {
            tenantId: string;
            userId: string;
            courseId: { in: string[] };
            status?: { in: string[] };
          };
        }) =>
          matriculas.filter(
            (m) =>
              m.tenantId === args.where.tenantId &&
              m.userId === args.where.userId &&
              args.where.courseId.in.includes(m.courseId) &&
              (!args.where.status || args.where.status.in.includes(m.status)),
          ),
      ),
      findFirst: vi.fn(
        async (args: { where: { tenantId: string; userId: string; courseId: string } }) =>
          deAlumno(args.where),
      ),
      // La forma antigua de `enrollUser` buscaba así la matrícula del curso.
      // Se conserva en el doble para que el control (revertir el arreglo)
      // falle por lo que tiene que fallar: una matrícula de más.
      findUnique: vi.fn(
        async (args: {
          where: {
            tenantId_userId_courseId: { tenantId: string; userId: string; courseId: string };
          };
        }) => deAlumno(args.where.tenantId_userId_courseId),
      ),
      create: vi.fn(
        async (args: {
          data: { tenantId: string; userId: string; courseId: string; source: string };
        }) => {
          const fila: Matricula = {
            id: `e-${++n}`,
            status: 'ACTIVE',
            cancelledAt: null,
            ...args.data,
          };
          matriculas.push(fila);
          return fila;
        },
      ),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<Matricula> }) => {
        const fila = matriculas.find((m) => m.id === args.where.id)!;
        Object.assign(fila, args.data);
        return fila;
      }),
    },
    modCoursesCourse: {
      findFirst: vi.fn(
        async (args: { where: { tenantId: string; id: string } }) =>
          [...cursos.values()].find(
            (c) => c.tenantId === args.where.tenantId && c.id === args.where.id && !c.deletedAt,
          ) ?? null,
      ),
      findMany: vi.fn(async (args: { where: { id: { in: string[] }; status?: string } }) =>
        [...cursos.values()].filter(
          (c) =>
            args.where.id.in.includes(c.id) &&
            (!args.where.status || c.status === args.where.status),
        ),
      ),
    },
    async $transaction<R>(fn: (tx: unknown) => Promise<R>): Promise<R> {
      return fn(prisma);
    },
  };

  const ctx = { eventBus: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } };
  const learning = new LearningService(prisma as never, ctx as never, async (_t, courseId) =>
    aLaVenta.has(courseId),
  );
  const paths = new LearningPathsService(prisma as never, ctx as never, learning);

  /** Cursos en los que el alumno tiene acceso de verdad al terminar. */
  const conAcceso = () =>
    matriculas
      .filter((m) => m.status === 'ACTIVE' || m.status === 'COMPLETED')
      .map((m) => m.courseId)
      .sort();

  return { prisma, learning, paths, matriculas, cursos, aLaVenta, conAcceso, ctx };
}

describe('LearningPathsService.enrollUser — la ruta no regala cursos de pago', () => {
  it('un curso con precio en el aula NO se matricula y se devuelve como pendiente', async () => {
    const m = mundo({ cursos: [{ id: 'pago' }], aLaVenta: ['pago'] });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(m.conAcceso()).toEqual([]);
    expect(m.matriculas).toHaveLength(0);
    expect(res.coursesWithoutAccess).toEqual(['pago']);
    // La inscripción en la ruta sí se hace: el alumno la sigue y ve qué le falta.
    expect(res.status).toBe('ACTIVE');
  });

  it('un curso con página de compra externa tampoco', async () => {
    const m = mundo({
      cursos: [{ id: 'externo', externalPurchaseUrl: 'https://academia.ejemplo.com/curso' }],
    });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(m.conAcceso()).toEqual([]);
    expect(res.coursesWithoutAccess).toEqual(['externo']);
  });

  it('un curso gratuito sí se matricula, y avisa como cualquier otra matrícula', async () => {
    const m = mundo({ cursos: [{ id: 'gratis' }] });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(m.conAcceso()).toEqual(['gratis']);
    expect(res.coursesWithoutAccess).toEqual([]);
    // Antes la ruta escribía la fila a pelo y nadie se enteraba: ni
    // notificaciones, ni webhooks, ni gamificación.
    expect(m.ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'learning.enrollment.created' }),
    );
  });

  it('un curso que el alumno ya compró o tiene por su grupo no se toca', async () => {
    const m = mundo({
      cursos: [{ id: 'comprado' }, { id: 'acabado' }],
      aLaVenta: ['comprado', 'acabado'],
      matriculas: [
        { courseId: 'comprado', status: 'ACTIVE', source: 'PURCHASE' },
        { courseId: 'acabado', status: 'COMPLETED', source: 'GROUP' },
      ],
    });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(res.coursesWithoutAccess).toEqual([]);
    expect(m.conAcceso()).toEqual(['acabado', 'comprado']);
    // Ni se duplica ni se le cambia la procedencia a la compra.
    expect(m.matriculas.map((x) => x.source).sort()).toEqual(['GROUP', 'PURCHASE']);
  });

  it('una matrícula en pausa por impago no cuenta como acceso ni se reactiva', async () => {
    const m = mundo({
      cursos: [{ id: 'pago' }],
      aLaVenta: ['pago'],
      matriculas: [{ courseId: 'pago', status: 'PAUSED', source: 'SUBSCRIPTION' }],
    });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(res.coursesWithoutAccess).toEqual(['pago']);
    expect(m.matriculas[0]!.status).toBe('PAUSED');
  });

  it('ruta mixta: entra en el gratuito, conserva el comprado y el de pago queda fuera', async () => {
    const m = mundo({
      cursos: [{ id: 'gratis' }, { id: 'comprado' }, { id: 'pago' }],
      aLaVenta: ['comprado', 'pago'],
      matriculas: [{ courseId: 'comprado', status: 'ACTIVE', source: 'PURCHASE' }],
    });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(m.conAcceso()).toEqual(['comprado', 'gratis']);
    expect(res.coursesWithoutAccess).toEqual(['pago']);
  });

  it('un curso sin publicar dentro de la ruta queda pendiente, no revienta', async () => {
    const m = mundo({ cursos: [{ id: 'borrador', status: 'DRAFT' }, { id: 'gratis' }] });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(m.conAcceso()).toEqual(['gratis']);
    expect(res.coursesWithoutAccess).toEqual(['borrador']);
  });

  it('si el curso pasa a venderse entre la consulta y la matrícula, queda pendiente', async () => {
    const m = mundo({ cursos: [{ id: 'c' }] });
    const real = m.learning.enrollSelf.bind(m.learning);
    vi.spyOn(m.learning, 'enrollSelf').mockImplementation(async (...args) => {
      m.aLaVenta.add('c');
      return real(...args);
    });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(m.conAcceso()).toEqual([]);
    expect(res.coursesWithoutAccess).toEqual(['c']);
  });

  it('un fallo de verdad al matricular se propaga y NO deja al alumno inscrito a medias', async () => {
    const m = mundo({ cursos: [{ id: 'gratis' }] });
    vi.spyOn(m.learning, 'enrollSelf').mockRejectedValue(new Error('la base no responde'));

    await expect(m.paths.enrollUser(T, ALUMNO, 'p-1')).rejects.toThrow('la base no responde');
    // Sin inscripción en la ruta: puede reintentar sin toparse con «ya inscrito».
    expect(m.prisma.modLearningPathEnrollment.upsert).not.toHaveBeenCalled();
  });

  it('ya inscrito en la ruta → error, como antes', async () => {
    const m = mundo({ cursos: [{ id: 'gratis' }], inscripcion: 'ACTIVE' });

    await expect(m.paths.enrollUser(T, ALUMNO, 'p-1')).rejects.toBeInstanceOf(
      LearningPathAlreadyEnrolledError,
    );
  });

  it('volver a una ruta abandonada tampoco regala el curso de pago', async () => {
    const m = mundo({ cursos: [{ id: 'pago' }], aLaVenta: ['pago'], inscripcion: 'CANCELLED' });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(res.status).toBe('ACTIVE');
    expect(m.conAcceso()).toEqual([]);
  });
});

describe('el equipo sigue pudiendo matricular a mano en un curso de pago', () => {
  it('enrollByAdmin matricula en un curso a la venta: el gate es solo de la automatrícula', async () => {
    const m = mundo({
      cursos: [{ id: 'pago', externalPurchaseUrl: 'https://academia.ejemplo.com/curso' }],
      aLaVenta: ['pago'],
    });

    // El alumno no puede solo…
    await expect(m.learning.enrollSelf(T, ALUMNO, 'pago')).rejects.toBeInstanceOf(
      CourseNotFreeError,
    );
    expect(m.conAcceso()).toEqual([]);

    // …pero un admin sí puede dárselo.
    const e = await m.learning.enrollByAdmin(T, 'u-admin', { userId: ALUMNO, courseId: 'pago' });

    expect(e.status).toBe('ACTIVE');
    expect(e.source).toBe('ADMIN');
    expect(m.conAcceso()).toEqual(['pago']);
  });

  it('y lo que el admin dio a mano cuenta como acceso al apuntarse a la ruta', async () => {
    const m = mundo({ cursos: [{ id: 'pago' }], aLaVenta: ['pago'] });
    await m.learning.enrollByAdmin(T, 'u-admin', { userId: ALUMNO, courseId: 'pago' });

    const res = await m.paths.enrollUser(T, ALUMNO, 'p-1');

    expect(res.coursesWithoutAccess).toEqual([]);
    expect(m.matriculas).toHaveLength(1);
  });
});

describe('LearningService.canSelfEnroll — la misma regla que enrollSelf, sin matricular', () => {
  it('responde lo que haría enrollSelf en cada caso', async () => {
    const m = mundo({
      cursos: [
        { id: 'gratis' },
        { id: 'vendido' },
        { id: 'externo', externalPurchaseUrl: 'https://academia.ejemplo.com/curso' },
        { id: 'borrador', status: 'DRAFT' },
      ],
      aLaVenta: ['vendido'],
    });

    expect(await m.learning.canSelfEnroll(T, 'gratis')).toBe(true);
    expect(await m.learning.canSelfEnroll(T, 'vendido')).toBe(false);
    expect(await m.learning.canSelfEnroll(T, 'externo')).toBe(false);
    expect(await m.learning.canSelfEnroll(T, 'no-existe')).toBe(false);
    expect(await m.learning.canSelfEnroll(T, 'borrador')).toBe(false);
    // Preguntar no matricula.
    expect(m.matriculas).toHaveLength(0);
  });
});

describe('LearningPathsService.getPath — la ficha dice el acceso a cada curso', () => {
  it('con alumno: título, slug y acceso de cada curso', async () => {
    const m = mundo({
      cursos: [{ id: 'comprado' }, { id: 'gratis' }, { id: 'pago' }],
      aLaVenta: ['comprado', 'pago'],
      matriculas: [{ courseId: 'comprado', status: 'ACTIVE', source: 'PURCHASE' }],
    });

    const path = await m.paths.getPath(T, 'ruta', ALUMNO);

    expect(path.courses).toEqual([
      expect.objectContaining({
        courseId: 'comprado',
        title: 'Curso comprado',
        slug: 'slug-comprado',
        access: 'enrolled',
      }),
      expect.objectContaining({ courseId: 'gratis', access: 'free' }),
      expect.objectContaining({ courseId: 'pago', access: 'locked' }),
    ]);
    // Mirar la ficha no matricula en nada.
    expect(m.matriculas).toHaveLength(1);
  });

  it('un borrador metido en la ruta no enseña su título y sale como no disponible', async () => {
    const m = mundo({ cursos: [{ id: 'borrador', status: 'DRAFT' }] });

    const path = await m.paths.getPath(T, 'ruta', ALUMNO);

    // Nadie lo vende, pero en un borrador no hay quien se matricule: decir
    // «gratis» sería prometer algo que `enrollSelf` va a rechazar.
    expect(path.courses[0]).toMatchObject({
      courseId: 'borrador',
      title: null,
      slug: null,
      access: 'locked',
    });
  });

  it('sin alumno: el acceso va a null', async () => {
    const m = mundo({ cursos: [{ id: 'c' }] });

    const path = await m.paths.getPath(T, 'ruta');

    expect(path.courses[0]).toMatchObject({ courseId: 'c', access: null });
  });
});
