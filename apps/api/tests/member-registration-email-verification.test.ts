/**
 * Tests de `EmailVerificationService` (paso 1.5 del flujo de inscripción de
 * miembros — OTP de 6 dígitos por email).
 *
 * Cubre:
 *  - requestCode: crea una fila, invalida las previas vigentes, audita y llama
 *    al SMTP (mock). Devuelve el TTL en segundos. NUNCA loguea el código.
 *  - verifyCode: código correcto → true y marca `usedAt`; código incorrecto →
 *    false e incrementa `attempts`; attempts >= MAX → false; expirado → false;
 *    sin fila vigente → false.
 *
 * Patrón fake-prisma in-memory (clon de password-reset.test.ts): objetos mock
 * sin DB real ni crypto pesada. El hash es SHA-256 hex (idéntico al service).
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EmailVerificationService } from '../src/modules/member-registration/email-verification.service';

const TENANT_ID = 'tenant-1';
const EMAIL = 'aspirante@example.com';
const CTX = { ip: '203.0.113.7', userAgent: 'vitest-agent' };

/** SHA-256 hex — mismo formato que `EmailVerificationService.hashCode`. */
function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

interface CodeRow {
  id: string;
  tenantId: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  attempts: number;
  requestIp: string | null;
  requestUa: string | null;
  createdAt: Date;
}

function makeFakePrisma() {
  const codes: CodeRow[] = [];
  let autoId = 1;
  let clock = 1; // contador monótono para createdAt (desempata el orderBy desc).

  return {
    codes,
    tenant: {
      async findUnique(_args: { where: { id: string } }) {
        return { name: 'Academia Demo' };
      },
    },
    emailVerificationCode: {
      async create(args: {
        data: {
          tenantId: string;
          email: string;
          codeHash: string;
          expiresAt: Date;
          attempts: number;
          requestIp: string | null;
          requestUa: string | null;
        };
      }) {
        const row: CodeRow = {
          id: `otp-${autoId++}`,
          ...args.data,
          usedAt: null,
          createdAt: new Date(clock++),
        };
        codes.push(row);
        return row;
      },
      async updateMany(args: {
        where: { tenantId: string; email: string; usedAt: null; expiresAt: { gt: Date } };
        data: { usedAt: Date };
      }) {
        let count = 0;
        for (const c of codes) {
          if (
            c.tenantId === args.where.tenantId &&
            c.email === args.where.email &&
            c.usedAt === null &&
            c.expiresAt.getTime() > args.where.expiresAt.gt.getTime()
          ) {
            c.usedAt = args.data.usedAt;
            count++;
          }
        }
        return { count };
      },
      async findFirst(args: {
        where: { tenantId: string; email: string; usedAt: null };
        orderBy: { createdAt: 'desc' };
      }) {
        const matches = codes
          .filter(
            (c) =>
              c.tenantId === args.where.tenantId &&
              c.email === args.where.email &&
              c.usedAt === null,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matches[0] ?? null;
      },
      async update(args: {
        where: { id: string };
        data: { attempts?: { increment: number }; usedAt?: Date };
      }) {
        const c = codes.find((x) => x.id === args.where.id);
        if (!c) throw new Error('code not found');
        if (args.data.attempts?.increment !== undefined) c.attempts += args.data.attempts.increment;
        if (args.data.usedAt !== undefined) c.usedAt = args.data.usedAt;
        return c;
      },
    },
  };
}

const fakeAuditLog = {
  async record(_input: unknown) {
    /* noop */
  },
};

const fakeSmtp = {
  async send() {
    return { ok: true, messageId: 'fake' };
  },
};

const fakeSmtpResolver = {
  async resolve(_tenantId: string) {
    return { config: {}, source: 'global' as const, verified: true };
  },
};

const fakeLogger = { warn: () => {}, log: () => {}, error: () => {}, debug: () => {} };

function makeService() {
  const prisma = makeFakePrisma();
  const service = new EmailVerificationService(
    prisma as never,
    fakeAuditLog as never,
    fakeSmtp as never,
    fakeSmtpResolver as never,
    fakeLogger as never,
  );
  return { service, prisma };
}

/** Inserta una fila OTP directamente para los tests de verifyCode. */
function seedCode(
  prisma: ReturnType<typeof makeFakePrisma>,
  overrides: Partial<CodeRow> & { codeHash: string },
): CodeRow {
  const row: CodeRow = {
    id: `seed-${prisma.codes.length + 1}`,
    tenantId: TENANT_ID,
    email: EMAIL,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    usedAt: null,
    attempts: 0,
    requestIp: null,
    requestUa: null,
    createdAt: new Date(),
    ...overrides,
  };
  prisma.codes.push(row);
  return row;
}

describe('EmailVerificationService.requestCode', () => {
  it('crea una fila, persiste el hash (no el código en claro) y devuelve el TTL en segundos', async () => {
    const { service, prisma } = makeService();
    const expiresInSeconds = await service.requestCode(TENANT_ID, EMAIL, CTX);

    expect(expiresInSeconds).toBe(600); // 10 minutos.
    expect(prisma.codes).toHaveLength(1);
    const row = prisma.codes[0];
    expect(row.tenantId).toBe(TENANT_ID);
    expect(row.email).toBe(EMAIL);
    expect(row.attempts).toBe(0);
    expect(row.usedAt).toBeNull();
    // El codeHash es SHA-256 hex de 64 chars; nunca el código en claro.
    expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('expira a los 10 minutos del request', async () => {
    const { service, prisma } = makeService();
    const before = Date.now();
    await service.requestCode(TENANT_ID, EMAIL, CTX);
    const delta = prisma.codes[0].expiresAt.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(9 * 60_000);
    expect(delta).toBeLessThanOrEqual(11 * 60_000);
  });

  it('invalida los códigos previos vigentes al pedir uno nuevo', async () => {
    const { service, prisma } = makeService();
    await service.requestCode(TENANT_ID, EMAIL, CTX);
    await service.requestCode(TENANT_ID, EMAIL, CTX);

    expect(prisma.codes).toHaveLength(2);
    // El primero quedó invalidado (usedAt seteado), el segundo sigue vigente.
    expect(prisma.codes[0].usedAt).not.toBeNull();
    expect(prisma.codes[1].usedAt).toBeNull();
  });

  it('llama al SMTP con el código (envío best-effort)', async () => {
    const prisma = makeFakePrisma();
    let sendCalls = 0;
    const smtp = {
      async send() {
        sendCalls++;
        return { ok: true, messageId: 'fake' };
      },
    };
    const service = new EmailVerificationService(
      prisma as never,
      fakeAuditLog as never,
      smtp as never,
      fakeSmtpResolver as never,
      fakeLogger as never,
    );
    await service.requestCode(TENANT_ID, EMAIL, CTX);
    expect(sendCalls).toBe(1);
  });

  it('no lanza aunque no haya SMTP resoluble (best-effort)', async () => {
    const prisma = makeFakePrisma();
    const resolver = {
      async resolve() {
        return null;
      },
    };
    const service = new EmailVerificationService(
      prisma as never,
      fakeAuditLog as never,
      fakeSmtp as never,
      resolver as never,
      fakeLogger as never,
    );
    const seconds = await service.requestCode(TENANT_ID, EMAIL, CTX);
    expect(seconds).toBe(600);
    // La fila igual se persiste; solo se salta el envío.
    expect(prisma.codes).toHaveLength(1);
  });
});

describe('EmailVerificationService.verifyCode', () => {
  it('con el código correcto devuelve true y marca usedAt (single-use)', async () => {
    const { service, prisma } = makeService();
    seedCode(prisma, { codeHash: hashCode('123456') });

    const ok = await service.verifyCode(TENANT_ID, EMAIL, '123456', CTX);
    expect(ok).toBe(true);
    expect(prisma.codes[0].usedAt).not.toBeNull();
  });

  it('con un código incorrecto devuelve false e incrementa attempts', async () => {
    const { service, prisma } = makeService();
    seedCode(prisma, { codeHash: hashCode('123456') });

    const ok = await service.verifyCode(TENANT_ID, EMAIL, '000000', CTX);
    expect(ok).toBe(false);
    expect(prisma.codes[0].attempts).toBe(1);
    expect(prisma.codes[0].usedAt).toBeNull();
  });

  it('rechaza (false) cuando ya se alcanzó el máximo de intentos', async () => {
    const { service, prisma } = makeService();
    // attempts ya en 5 (MAX_ATTEMPTS): el código quedó inservible.
    seedCode(prisma, { codeHash: hashCode('123456'), attempts: 5 });

    const ok = await service.verifyCode(TENANT_ID, EMAIL, '123456', CTX);
    expect(ok).toBe(false);
    // No incrementa más allá del máximo (la guarda corta antes).
    expect(prisma.codes[0].attempts).toBe(5);
  });

  it('rechaza (false) un código expirado aunque el dígito sea correcto', async () => {
    const { service, prisma } = makeService();
    seedCode(prisma, {
      codeHash: hashCode('123456'),
      expiresAt: new Date(Date.now() - 1000),
    });

    const ok = await service.verifyCode(TENANT_ID, EMAIL, '123456', CTX);
    expect(ok).toBe(false);
    expect(prisma.codes[0].usedAt).toBeNull();
  });

  it('devuelve false cuando no hay ninguna fila vigente para (tenant, email)', async () => {
    const { service } = makeService();
    const ok = await service.verifyCode(TENANT_ID, EMAIL, '123456', CTX);
    expect(ok).toBe(false);
  });

  it('ignora filas ya usadas y verifica contra la más reciente vigente', async () => {
    const { service, prisma } = makeService();
    // Una vieja ya usada (no debe considerarse) y una nueva vigente con otro código.
    seedCode(prisma, {
      codeHash: hashCode('111111'),
      usedAt: new Date(),
      createdAt: new Date(1),
    });
    seedCode(prisma, { codeHash: hashCode('999999'), createdAt: new Date(2) });

    expect(await service.verifyCode(TENANT_ID, EMAIL, '111111', CTX)).toBe(false);
    expect(await service.verifyCode(TENANT_ID, EMAIL, '999999', CTX)).toBe(true);
  });
});
