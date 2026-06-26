/**
 * Tests de `MemberDecisionService` (decisión del aprobador sobre una inscripción
 * PENDING: aprobar / rechazar mediante tokens firmados de un solo uso).
 *
 * Cubre:
 *  - issueDecisionTokens: persiste 2 filas (APPROVE/REJECT) y devuelve 2 raw distintos.
 *  - decide token inexistente → {outcome:'invalid'}.
 *  - decide token ya decidido (decidedAt set) → {outcome:'already'}.
 *  - decide token expirado → {outcome:'expired'}.
 *  - decide APPROVE válido → User ACTIVE + sella decidedAt de ambos +
 *    delega el acceso en AccessGroupsService.assignDefaultGroupOnApproval → {outcome:'approved'}.
 *  - decide REJECT válido → User DEACTIVATED (sin asignar grupo) → {outcome:'rejected'}.
 *
 * Fase 2: el fan-out a cursos (antes enrollAllPublished en este service) vive
 * ahora en AccessGroupsService; aquí solo se verifica la DELEGACIÓN. La lógica
 * de matriculación/refcount se cubre en access-groups.service.test.ts.
 *
 * Usa fake-prisma in-memory. El service hashea los raw con node:crypto real
 * (SHA-256), así que guardamos los raw que issueDecisionTokens devuelve y los
 * reinyectamos en decide para que el lookup por hash cuadre.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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

/** Monta el harness con fake-prisma in-memory + mocks. */
function makeHarness() {
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
    tenant: {
      async findUnique() {
        return { name: 'VA360 LABS' };
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

  const assignDefaultGroupOnApproval = vi.fn().mockResolvedValue(undefined);
  const accessGroups = { assignDefaultGroupOnApproval } as never;

  const smtp = { send: vi.fn().mockResolvedValue({ ok: true }) };
  const smtpResolver = {
    resolve: vi.fn().mockResolvedValue({ config: {}, source: 'global', verified: true }),
  } as never;
  const auditLog = { record: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  const service = new MemberDecisionService(
    prisma,
    accessGroups,
    smtp as never,
    smtpResolver,
    auditLog as never,
    logger,
  );

  return { service, prisma, tokens, users, assignDefaultGroupOnApproval, smtp, auditLog };
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
    const approveRow = h.tokens.find((t) => t.action === 'APPROVE')!;
    const rejectRow = h.tokens.find((t) => t.action === 'REJECT')!;
    expect(approveRow.tokenHash).toBe(sha256(approveToken));
    expect(rejectRow.tokenHash).toBe(sha256(rejectToken));
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
    h.tokens.forEach((t) => (t.decidedAt = new Date()));

    const result = await h.service.decide(approveToken, CTX);
    expect(result).toEqual({ outcome: 'already' });
  });

  it('token expirado → expired', async () => {
    const h = makeHarness();
    const { approveToken } = await h.service.issueDecisionTokens(TENANT_ID, USER_ID, CTX);
    h.tokens.forEach((t) => (t.expiresAt = new Date(Date.now() - 1000)));

    const result = await h.service.decide(approveToken, CTX);
    expect(result).toEqual({ outcome: 'expired' });
  });

  it('APPROVE válido → User ACTIVE, sella ambos tokens, asigna grupo por defecto y devuelve approved', async () => {
    const h = makeHarness();
    const { approveToken } = await h.service.issueDecisionTokens(TENANT_ID, USER_ID, CTX);

    const result = await h.service.decide(approveToken, CTX);

    expect(result).toEqual({ outcome: 'approved' });
    expect(h.users[0].status).toBe('ACTIVE');
    expect(h.users[0].approvalDecidedAt).not.toBeNull();
    expect(h.tokens.every((t) => t.decidedAt !== null)).toBe(true);
    // Delega el acceso en mod.access-groups (grupo por defecto al aprobar).
    expect(h.assignDefaultGroupOnApproval).toHaveBeenCalledTimes(1);
    expect(h.assignDefaultGroupOnApproval).toHaveBeenCalledWith(TENANT_ID, USER_ID);
    expect(h.auditLog.record.mock.calls[0][0].action).toBe('member.approved');
  });

  it('REJECT válido → User DEACTIVATED y devuelve rejected (sin asignar grupo)', async () => {
    const h = makeHarness();
    const { rejectToken } = await h.service.issueDecisionTokens(TENANT_ID, USER_ID, CTX);

    const result = await h.service.decide(rejectToken, CTX);

    expect(result).toEqual({ outcome: 'rejected' });
    expect(h.users[0].status).toBe('DEACTIVATED');
    expect(h.tokens.every((t) => t.decidedAt !== null)).toBe(true);
    expect(h.assignDefaultGroupOnApproval).not.toHaveBeenCalled();
    expect(h.auditLog.record.mock.calls[0][0].action).toBe('member.rejected');
  });
});
