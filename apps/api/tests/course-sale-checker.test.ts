/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  buildCourseSaleChecker,
  type CourseSaleCatalogDb,
} from '../src/modules/course-sale-checker';

/**
 * ¿Por qué cursos cobra el tenant? De la respuesta depende que un alumno
 * pueda matricularse solo (`enrollments/me`) y que apuntarse a una ruta de
 * aprendizaje le matricule en el curso.
 *
 * El hueco que cierra este fichero: una academia que vende «membresía = todos
 * los cursos» no tiene producto por curso, así que con el criterio anterior
 * (solo `ModBillingProduct` + suscripción al curso) ningún curso constaba
 * como de pago y cualquiera con sesión se los llevaba todos.
 */

const T = 't-1';
const OTRO_TENANT = 't-2';

/**
 * La parte de Prisma que usa el comprobador, con la forma exacta de las
 * consultas que hace. El comprobador se tipa contra el cliente real; este
 * doble se le pasa con un cast, y que las consultas valen contra el esquema
 * de verdad lo prueba `tests/integration/course-sale-checker.integration.test.ts`.
 */
interface FakeCatalog {
  modBillingProduct: {
    findFirst(args: {
      where: { tenantId: string; courseId: string; active: true };
    }): Promise<{ id: string } | null>;
  };
  modSubscriptionsSubscription: {
    findFirst(args: {
      where: { tenantId: string; courseId: string };
    }): Promise<{ id: string } | null>;
  };
  modAccessGroup: {
    findMany(args: {
      where: {
        tenantId: string;
        deletedAt: null;
        OR: [{ kind: 'ALL_COURSES' }, { courses: { some: { courseId: string } } }];
      };
    }): Promise<Array<{ id: string; linkedTierName: string | null }>>;
  };
  modSubscriptionsMembershipConfig: {
    findUnique(args: {
      where: { tenantId: string };
    }): Promise<{ accessGroupId: string | null } | null>;
  };
  modPaymentConnectionsTier: {
    findMany(args: {
      where: { tenantId: string; name: { in: string[] } };
    }): Promise<Array<{ name: string; isFree: boolean }>>;
  };
}

interface Grupo {
  id: string;
  tenantId: string;
  kind: 'ALL_COURSES' | 'COURSE' | 'MULTI_COURSE';
  courseIds: string[];
  linkedTierName: string | null;
  deletedAt: Date | null;
}

function catalogo(seed: {
  productos?: Array<{ tenantId?: string; courseId: string; active?: boolean }>;
  suscripciones?: Array<{ tenantId?: string; courseId: string }>;
  grupos?: Array<Partial<Grupo> & { id: string }>;
  /** Grupo que concede la membresía del tenant T. */
  grupoMembresia?: string | null;
  tiers?: Array<{ tenantId?: string; name: string; isFree: boolean }>;
}): FakeCatalog {
  const grupos: Grupo[] = (seed.grupos ?? []).map((g) => ({
    tenantId: T,
    kind: 'MULTI_COURSE',
    courseIds: [],
    linkedTierName: null,
    deletedAt: null,
    ...g,
  }));
  return {
    modBillingProduct: {
      async findFirst({ where }) {
        const hit = (seed.productos ?? []).find(
          (p) =>
            (p.tenantId ?? T) === where.tenantId &&
            p.courseId === where.courseId &&
            (p.active ?? true) === true,
        );
        return hit ? { id: 'prod' } : null;
      },
    },
    modSubscriptionsSubscription: {
      async findFirst({ where }) {
        const hit = (seed.suscripciones ?? []).find(
          (s) => (s.tenantId ?? T) === where.tenantId && s.courseId === where.courseId,
        );
        return hit ? { id: 'sub' } : null;
      },
    },
    modAccessGroup: {
      async findMany({ where }) {
        const courseId = where.OR[1].courses.some.courseId;
        return grupos
          .filter(
            (g) =>
              g.tenantId === where.tenantId &&
              g.deletedAt === null &&
              (g.kind === 'ALL_COURSES' || g.courseIds.includes(courseId)),
          )
          .map((g) => ({ id: g.id, linkedTierName: g.linkedTierName }));
      },
    },
    modSubscriptionsMembershipConfig: {
      async findUnique({ where }) {
        if (where.tenantId !== T || seed.grupoMembresia === undefined) return null;
        return { accessGroupId: seed.grupoMembresia };
      },
    },
    modPaymentConnectionsTier: {
      async findMany({ where }) {
        return (seed.tiers ?? [])
          .filter((t) => (t.tenantId ?? T) === where.tenantId && where.name.in.includes(t.name))
          .map((t) => ({ name: t.name, isFree: t.isFree }));
      },
    },
  };
}

const seVende = (db: FakeCatalog, courseId = 'c-1') =>
  buildCourseSaleChecker(() => db as unknown as CourseSaleCatalogDb)(T, courseId);

describe('buildCourseSaleChecker — por qué cursos cobra el tenant', () => {
  it('un curso sin precio, sin suscripción y sin grupo de pago es gratuito', async () => {
    expect(await seVende(catalogo({}))).toBe(false);
  });

  it('con precio propio activo, se vende', async () => {
    expect(await seVende(catalogo({ productos: [{ courseId: 'c-1' }] }))).toBe(true);
  });

  it('un precio DESACTIVADO no cuenta', async () => {
    expect(await seVende(catalogo({ productos: [{ courseId: 'c-1', active: false }] }))).toBe(
      false,
    );
  });

  it('con suscripción al curso, se vende', async () => {
    expect(await seVende(catalogo({ suscripciones: [{ courseId: 'c-1' }] }))).toBe(true);
  });

  it('el precio de OTRO tenant no convierte el curso en de pago', async () => {
    expect(
      await seVende(catalogo({ productos: [{ tenantId: OTRO_TENANT, courseId: 'c-1' }] })),
    ).toBe(false);
  });

  describe('cursos que se entregan con la membresía', () => {
    it('membresía = TODOS los cursos: cualquier curso es de pago', async () => {
      const db = catalogo({
        grupos: [{ id: 'g-socios', kind: 'ALL_COURSES' }],
        grupoMembresia: 'g-socios',
      });
      expect(await seVende(db, 'c-1')).toBe(true);
      expect(await seVende(db, 'cualquier-otro')).toBe(true);
    });

    it('membresía con lista de cursos: solo los de la lista', async () => {
      const db = catalogo({
        grupos: [{ id: 'g-socios', courseIds: ['c-1'] }],
        grupoMembresia: 'g-socios',
      });
      expect(await seVende(db, 'c-1')).toBe(true);
      expect(await seVende(db, 'c-fuera')).toBe(false);
    });

    it('el grupo de la membresía BORRADO ya no vende nada', async () => {
      const db = catalogo({
        grupos: [{ id: 'g-socios', kind: 'ALL_COURSES', deletedAt: new Date() }],
        grupoMembresia: 'g-socios',
      });
      expect(await seVende(db)).toBe(false);
    });

    it('membresía sin grupo configurado: no hay nada que proteger', async () => {
      const db = catalogo({
        grupos: [{ id: 'g-equipo', kind: 'ALL_COURSES' }],
        grupoMembresia: null,
      });
      expect(await seVende(db)).toBe(false);
    });
  });

  describe('cursos que se entregan con un tier', () => {
    it('grupo vinculado a un tier de pago: el curso es de pago', async () => {
      const db = catalogo({
        grupos: [{ id: 'g-pro', courseIds: ['c-1'], linkedTierName: 'Pro' }],
        tiers: [{ name: 'Pro', isFree: false }],
      });
      expect(await seVende(db)).toBe(true);
    });

    it('grupo vinculado a un tier marcado como GRATUITO: no es de pago', async () => {
      const db = catalogo({
        grupos: [{ id: 'g-free', courseIds: ['c-1'], linkedTierName: 'Free' }],
        tiers: [{ name: 'Free', isFree: true }],
      });
      expect(await seVende(db)).toBe(false);
    });

    it('un tier que no está en el catálogo se trata como de pago', async () => {
      const db = catalogo({
        grupos: [{ id: 'g-x', courseIds: ['c-1'], linkedTierName: 'Plan anual' }],
        tiers: [],
      });
      expect(await seVende(db)).toBe(true);
    });

    it('con un grupo gratuito y otro de pago sobre el mismo curso, manda el de pago', async () => {
      const db = catalogo({
        grupos: [
          { id: 'g-free', courseIds: ['c-1'], linkedTierName: 'Free' },
          { id: 'g-pro', kind: 'ALL_COURSES', linkedTierName: 'Pro' },
        ],
        tiers: [
          { name: 'Free', isFree: true },
          { name: 'Pro', isFree: false },
        ],
      });
      expect(await seVende(db)).toBe(true);
    });

    it('el tier homónimo de OTRO tenant no decide nada aquí', async () => {
      const db = catalogo({
        grupos: [{ id: 'g-pro', courseIds: ['c-1'], linkedTierName: 'Pro' }],
        // En este tenant «Pro» no consta: de pago. Que en otro sea gratuito da igual.
        tiers: [{ tenantId: OTRO_TENANT, name: 'Pro', isFree: true }],
      });
      expect(await seVende(db)).toBe(true);
    });
  });

  describe('lo que NO convierte un curso en de pago', () => {
    it('un grupo sin vínculo de pago (alta manual, «Equipo» con todos los cursos)', async () => {
      const db = catalogo({ grupos: [{ id: 'g-equipo', kind: 'ALL_COURSES' }] });
      expect(await seVende(db)).toBe(false);
    });

    it('un grupo manual aunque exista una membresía sobre OTRO grupo', async () => {
      const db = catalogo({
        grupos: [
          { id: 'g-manual', courseIds: ['c-1'] },
          { id: 'g-socios', courseIds: ['c-otro'] },
        ],
        grupoMembresia: 'g-socios',
      });
      expect(await seVende(db, 'c-1')).toBe(false);
      expect(await seVende(db, 'c-otro')).toBe(true);
    });

    it('un grupo de pago de OTRO tenant', async () => {
      const db = catalogo({
        grupos: [
          { id: 'g-pro', tenantId: OTRO_TENANT, kind: 'ALL_COURSES', linkedTierName: 'Pro' },
        ],
      });
      expect(await seVende(db)).toBe(false);
    });
  });
});
