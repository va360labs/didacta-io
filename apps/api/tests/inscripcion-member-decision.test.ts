/**
 * Tests de `MemberDecisionService` (decisión del aprobador sobre una inscripción
 * PENDING: aprobar / rechazar mediante tokens firmados de un solo uso).
 *
 * Cubre:
 *  - issueDecisionTokens: persiste 2 filas (APPROVE/REJECT) y devuelve 2 raw distintos.
 *  - decide token inexistente → {outcome:'invalid'}.
 *  - decide token ya decidido (decidedAt set) → {outcome:'already'}.
 *  - decide token expirado → {outcome:'expired'}.
 *  - decide APPROVE válido → User ACTIVE + sella decidedAt de ambos + enrollAllPublished → {outcome:'approved'}.
 *  - decide REJECT válido → User DEACTIVATED → {outcome:'rejected'}.
 *  - AlreadyEnrolledError en un curso no aborta el bucle de matriculación.
 *
 * Usa fake-prisma in-memory. El service hashea los raw con node:crypto real
 * (SHA-256), así que guardamos los raw que issueDecisionTokens devuelve y los
 * reinyectamos en decide para que el lookup por hash cuadre.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AlreadyEnrolledError, LearningError } from '@didacta/mod-learning';
import { MemberDecisionService } from '../src/inscripcion/member-decision.service';
import type { ClientContext } from '../src/auth/client-context';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-pending';
const CTX: ClientContext = { ip: '1.2.3.4', userAgent: 'vitest' };

/** Hash SHA-256 hex, idéntico al que usa el service internamente. */
function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

interface DecisionTokenRow {
  id: string;
  tenantId: string;
  userId: string;
  action: 'APPROVE' | 'REJECT';
  tokenHash: string;
  expiresAt: Date;
  decidedAt: Date | null;
  requestIp: string | null;
  requestUa: string | null;
}

interface UserRow {
  id: string;
  tenantId: string;
  email: string | null;
  name: string | null;
  status: string;
  approvalDecidedAt: Date | null;
}

/**
 * Monta el harness con fake-prisma in-memory + mocks. `enrollImpl` permite
 * inyectar el comportamiento de enrollByAdmin (p. ej. lanzar AlreadyEnrolledError).
 */
function makeHarness(
  opts: {
    courses?: Array<{ id: string }>;
    enrollImpl?: (tenantId: string, userId: string, courseId: string) => Promise<unknown>;
  } = {},
) {
  const tokens: DecisionTokenRow[] = [];
  let tokenAutoId = 1;
  const users: UserRow[] = [
    {
      id: USER_ID,
      tenantId: TENANT_ID,
      email: 'ana@x.com',
      name: 'Ana López',
      status: 'PENDING',
      approvalDecidedAt: null,
    },
  ];

  const tx = {
    user: {
      async update(args: {
        where: { id: string };
        data: { status?: string; approvalDecidedAt?: Date };
      }) {
        const u = users.find((x) => x.id === args.where.id);
        if (!u) throw new Error('user not found');
        if (args.data.status !== undefined) u.status = args.data.status;
        if (args.data.approvalDecidedAt !== undefined)
          u.approvalDecidedAt = args.data.approvalDecidedAt;
        return u;
      },
    },
    memberRegistrationDecisionToken: {
      async updateMany(args: {
        where: { tenantId: string; userId: string; decidedAt: null };
        data: { decidedAt: Date };
      }) {
        let count = 0;
        for (const t of tokens) {
          if (
            t.tenantId === args.where.tenantId &&
            t.userId === args.where.userId &&
            t.decidedAt === null
          ) {
            t.decidedAt = args.data.decidedAt;
            count++;
          }
        }
        return { count };
      },
    },
  };

  const prisma = {
    tokens,
    users,
    user: {
      async findUnique(args: { where: { id: string } }) {
        return users.find((u) => u.id === args.where.id) ?? null;
      },
    },
    memberRegistrationDecisionToken: {
      async create(args: { data: Omit<DecisionTokenRow, 'id' | 'decidedAt'> }) {
        const row: DecisionTokenRow = {
          id: `dtok-${tokenAutoId++}`,
          decidedAt: null,
          ...args.data,
        };
        tokens.push(row);
        return row;
      },
      async findUnique(args: { where: { tokenHash: string } }) {
        return tokens.find((t) => t.tokenHash === args.where.tokenHash) ?? null;
      },
    },
    async $transaction(fn: (t: typeof tx) => unknown) {
      return fn(tx);
    },
  } as never;

  const courses = opts.courses ?? [{ id: 'c1' }];
  const listCourses = vi.fn().mockResolvedValue(courses);
  const enrollByAdmin = vi.fn(
    opts.enrollImpl ??
      (async (_t: string, _admin: unknown, payload: { courseId: string }) => ({
        id: `enr-${payload.courseId}`,
      })),
  );
  const coursesService = { listCourses };
  const learningService = { enrollByAdmin };
  const registry = {
    getCoursesService: () => coursesService,
    getLearningService: () => learningService,
  } as never;

  const smtp = { send: vi.fn().mockResolvedValue({ ok: true }) };
  const smtpResolver = {
    resolve: vi.fn().mockResolvedValue({ config: {}, source: 'global', verified: true }),
  } as never;
  const auditLog = { record: vi.fn().mockResolvedValue(undefined) };
  const tenantContext = {
    // run ejecuta el callback directamente (sin AsyncLocalStorage real).
    run: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  } as never;
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  const service = new MemberDecisionService(
    prisma,
    registry,
    smtp as never,
    smtpResolver,
    auditLog as never,
    tenantContext,
    logger,
  );

  return { service, prisma, tokens, users, listCourses, enrollByAdmin, smtp, auditLog };
}

describe('MemberDecisionService.issueDecisionTokens', () => {
  it('persiste 2 filas (APPROVE/REJECT) y devuelve 2 raw distintos', async () => {
    const h = makeHarness();

    const { approveToken, rejectToken } = await h.service.issueDecisionTokens(
      TENANT_ID,
      USER_ID,
      CTX,
    );

    expect(approveToken).not.toBe(rejectToken);
    expect(approveToken).toMatch(/^[a-f0-9]{64}$/);
    expect(rejectToken).toMatch(/^[a-f0-9]{64}$/);

    expect(h.tokens).toHaveLength(2);
    const actions = h.tokens.map((t) => t.action).sort();
    expect(actions).toEqual(['APPROVE', 'REJECT']);
    // Solo se persiste el hash, no el raw.
    const approveRow = h.tokens.find((t) => t.action === 'APPROVE')!;
    const rejectRow = h.tokens.find((t) => t.action === 'REJECT')!;
    expect(approveRow.tokenHash).toBe(sha256(approveToken));
    expect(rejectRow.tokenHash).toBe(sha256(rejectToken));
    // TTL futuro y ctx capturado.
    expect(approveRow.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(approveRow.requestIp).toBe('1.2.3.4');
    expect(approveRow.requestUa).toBe('vitest');
  });
});

describe('MemberDecisionService.decide', () => {
  it('token inexistente → invalid', async () => {
    const h = makeHarness();
    const result = await h.service.decide('a'.repeat(64), CTX);
    expect(result).toEqual({ outcome: 'invalid' });
  });

  it('token ya decidido (decidedAt set) → already', async () => {
    const h = makeHarness();
    const { approveToken } = await h.service.issueDecisionTokens(TENANT_ID, USER_ID, CTX);
    // Forzamos que el token ya esté sellado.
    h.tokens.forEach((t) => (t.decidedAt = new Date()));

    const result = await h.service.decide(approveToken, CTX);
    expect(result).toEqual({ outcome: 'already' });
  });

  it('token expirado → expired', async () => {
    const h = makeHarness();
    const { approveToken } = await h.service.issueDecisionTokens(TENANT_ID, USER_ID, CTX);
    // Forzamos expiración en el pasado.
    h.tokens.forEach((t) => (t.expiresAt = new Date(Date.now() - 1000)));

    const result = await h.service.decide(approveToken, CTX);
    expect(result).toEqual({ outcome: 'expired' });
  });

  it('APPROVE válido → User ACTIVE, sella decidedAt de ambos tokens, matricula y devuelve approved', async () => {
    const h = makeHarness({ courses: [{ id: 'c1' }] });
    const { approveToken } = await h.service.issueDecisionTokens(TENANT_ID, USER_ID, CTX);

    const result = await h.service.decide(approveToken, CTX);

    expect(result).toEqual({ outcome: 'approved' });
    // User pasó a ACTIVE.
    expect(h.users[0].status).toBe('ACTIVE');
    expect(h.users[0].approvalDecidedAt).not.toBeNull();
    // AMBOS tokens (el consumido y su pareja) quedan sellados.
    expect(h.tokens.every((t) => t.decidedAt !== null)).toBe(true);
    // Matrícula en todos los cursos publicados.
    expect(h.listCourses).toHaveBeenCalledWith(TENANT_ID, { status: 'PUBLISHED' });
    expect(h.enrollByAdmin).toHaveBeenCalledTimes(1);
    expect(h.enrollByAdmin).toHaveBeenCalledWith(TENANT_ID, null, {
      userId: USER_ID,
      courseId: 'c1',
    });
    // Audit member.approved.
    expect(h.auditLog.record.mock.calls[0][0].action).toBe('member.approved');
  });

  it('REJECT válido → User DEACTIVATED y devuelve rejected (sin matricular)', async () => {
    const h = makeHarness();
    const { rejectToken } = await h.service.issueDecisionTokens(TENANT_ID, USER_ID, CTX);

    const result = await h.service.decide(rejectToken, CTX);

    expect(result).toEqual({ outcome: 'rejected' });
    expect(h.users[0].status).toBe('DEACTIVATED');
    expect(h.tokens.every((t) => t.decidedAt !== null)).toBe(true);
    // Rechazo no matricula.
    expect(h.enrollByAdmin).not.toHaveBeenCalled();
    expect(h.auditLog.record.mock.calls[0][0].action).toBe('member.rejected');
  });

  it('AlreadyEnrolledError en un curso no rompe el bucle: sigue con el resto y aprueba', async () => {
    const enrollImpl = vi.fn(async (_t: string, _admin: unknown, payload: { courseId: string }) => {
      if (payload.courseId === 'c1') throw new AlreadyEnrolledError();
      return { id: `enr-${payload.courseId}` };
    });
    const h = makeHarness({ courses: [{ id: 'c1' }, { id: 'c2' }], enrollImpl });
    const { approveToken } = await h.service.issueDecisionTokens(TENANT_ID, USER_ID, CTX);

    const result = await h.service.decide(approveToken, CTX);

    expect(result).toEqual({ outcome: 'approved' });
    // Se intentó matricular en ambos pese al AlreadyEnrolledError del primero.
    expect(h.enrollByAdmin).toHaveBeenCalledTimes(2);
    expect(h.users[0].status).toBe('ACTIVE');
  });

  it('LearningError genérico en un curso tampoco rompe el bucle', async () => {
    const enrollImpl = vi.fn(async (_t: string, _admin: unknown, payload: { courseId: string }) => {
      if (payload.courseId === 'c1') throw new LearningError('SOME_CODE', 'boom');
      return { id: `enr-${payload.courseId}` };
    });
    const h = makeHarness({ courses: [{ id: 'c1' }, { id: 'c2' }], enrollImpl });
    const { approveToken } = await h.service.issueDecisionTokens(TENANT_ID, USER_ID, CTX);

    const result = await h.service.decide(approveToken, CTX);

    expect(result).toEqual({ outcome: 'approved' });
    expect(h.enrollByAdmin).toHaveBeenCalledTimes(2);
  });
});
