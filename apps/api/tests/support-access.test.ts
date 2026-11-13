/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * U8 — acceso de soporte de vida corta.
 *
 * Una parte de este fichero comprueba que la funcionalidad hace lo que dice. La
 * otra comprueba lo que **no puede llegar a hacer**, que es lo que decide si
 * esto es un favor al cliente o una llave maestra escondida:
 *
 *   · que la ventana no pueda pasar de 15 minutos, la pida quien la pida;
 *   · que sea de un solo uso de verdad, incluso con dos canjes a la vez;
 *   · que soporte NUNCA entre con la identidad de una persona real;
 *   · que el aula avise mientras dure, y que el aviso no se pueda cerrar;
 *   · que la migración no cambie el comportamiento de ninguna instalación.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, GoneException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupportAccessService } from '../src/admin/support-access.service';
import {
  SUPPORT_ACCESS_CODES,
  SUPPORT_ACCESS_MAX_TTL_SECONDS,
  SUPPORT_USER_EMAIL,
  SUPPORT_USER_ROLE,
  clampTtlSeconds,
  generateSupportToken,
  hasSupportTokenPrefix,
  hashSupportToken,
  supportTokenMatches,
  verifyGrant,
} from '../src/tenancy/support-access';

const FUENTE = join(process.cwd(), 'src', 'tenancy', 'support-access.ts');
const SERVICIO = join(process.cwd(), 'src', 'admin', 'support-access.service.ts');
const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const ACTOR = { kind: 'user' as const, userId: 'user-super-1' };
const MOTIVO = 'Incidencia #4210: el alumno no ve sus lecciones.';

// ---------------------------------------------------------------------------
// Las reglas, sin base de datos
// ---------------------------------------------------------------------------

describe('U8 · la ventana', () => {
  it('el techo son 15 minutos y no lo mueve quien llama', () => {
    expect(SUPPORT_ACCESS_MAX_TTL_SECONDS).toBe(900);
    // Pedir más no es un error de validación: se sirve el techo. Así el límite
    // no depende de que ningún cliente —tampoco el plano de control— lo respete.
    expect(clampTtlSeconds(86_400)).toBe(900);
    expect(clampTtlSeconds(901)).toBe(900);
  });

  it('se puede pedir menos, con un suelo de un minuto', () => {
    expect(clampTtlSeconds(300)).toBe(300);
    expect(clampTtlSeconds(1)).toBe(60);
    expect(clampTtlSeconds(0)).toBe(60);
    expect(clampTtlSeconds(-999)).toBe(60);
  });

  it('sin pedir nada, la ventana es la máxima', () => {
    expect(clampTtlSeconds()).toBe(900);
    expect(clampTtlSeconds(null)).toBe(900);
    expect(clampTtlSeconds(Number.NaN)).toBe(900);
  });
});

describe('U8 · cuándo vale una concesión', () => {
  const futuro = new Date(Date.now() + 600_000);

  it('viva: ni canjeada, ni revocada, ni caducada', () => {
    expect(verifyGrant({ expiresAt: futuro, redeemedAt: null, revokedAt: null })).toEqual({
      ok: true,
    });
  });

  it('caducada', () => {
    const pasado = new Date(Date.now() - 1_000);
    expect(verifyGrant({ expiresAt: pasado, redeemedAt: null, revokedAt: null })).toEqual({
      ok: false,
      code: SUPPORT_ACCESS_CODES.EXPIRED,
    });
  });

  it('ya canjeada — de un solo uso', () => {
    expect(verifyGrant({ expiresAt: futuro, redeemedAt: new Date(), revokedAt: null })).toEqual({
      ok: false,
      code: SUPPORT_ACCESS_CODES.ALREADY_REDEEMED,
    });
  });

  it('revocada gana a todo lo demás: quien la cortó necesita saber que su corte valió', () => {
    expect(
      verifyGrant({ expiresAt: futuro, redeemedAt: new Date(), revokedAt: new Date() }),
    ).toEqual({ ok: false, code: SUPPORT_ACCESS_CODES.REVOKED });
  });
});

describe('U8 · el token', () => {
  it('lleva prefijo reconocible y no se repite', () => {
    const a = generateSupportToken();
    const b = generateSupportToken();
    expect(hasSupportTokenPrefix(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(40);
  });

  it('un token ajeno no cuela por parecerse', () => {
    expect(hasSupportTokenPrefix('didprov_loquesea')).toBe(false);
    const token = generateSupportToken();
    expect(supportTokenMatches(token, hashSupportToken(token))).toBe(true);
    expect(supportTokenMatches(`${token}x`, hashSupportToken(token))).toBe(false);
    expect(supportTokenMatches(token, 'abcd')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// El servicio
// ---------------------------------------------------------------------------

interface GrantRow {
  id: string;
  tenantId: string;
  tokenHash: string;
  reason: string;
  issuedByKind: string;
  issuedById: string;
  expiresAt: Date;
  redeemedAt: Date | null;
  sessionId: string | null;
  revokedAt: Date | null;
}

function makeHarness(overrides: { grant?: Partial<GrantRow>; tenantStatus?: string } = {}) {
  const grantRow: GrantRow = {
    id: 'grant-1',
    tenantId: TENANT_ID,
    tokenHash: 'hash',
    reason: MOTIVO,
    issuedByKind: 'user',
    issuedById: ACTOR.userId,
    expiresAt: new Date(Date.now() + 600_000),
    redeemedAt: null,
    sessionId: null,
    revokedAt: null,
    ...overrides.grant,
  };

  const prisma = {
    tenant: {
      findFirst: vi.fn().mockResolvedValue({
        id: TENANT_ID,
        slug: 'acme',
        status: overrides.tenantStatus ?? 'ACTIVE',
      }),
    },
    supportAccessGrant: {
      create: vi.fn().mockResolvedValue({ id: 'grant-1' }),
      findUnique: vi.fn().mockResolvedValue(grantRow),
      findFirst: vi.fn().mockResolvedValue(grantRow),
      findMany: vi.fn().mockResolvedValue([grantRow]),
      update: vi.fn().mockResolvedValue(grantRow),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'user-soporte', status: 'ACTIVE', deletedAt: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    role: { findUnique: vi.fn().mockResolvedValue({ id: 'role-tenant-admin' }) },
    session: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        user: { create: vi.fn().mockResolvedValue({ id: 'user-soporte-nuevo' }) },
        userRole: { create: vi.fn().mockResolvedValue({}) },
      }),
    ),
  };

  const auditLog = { record: vi.fn().mockResolvedValue(undefined) };
  const sessions = {
    issueSupportAccess: vi.fn().mockResolvedValue({
      accessToken: 'jwt-de-soporte',
      expiresIn: 600,
      sid: 'sess-soporte',
      expiresAt: new Date(Date.now() + 600_000),
    }),
  };
  const accountState = { invalidateSession: vi.fn(), invalidateUser: vi.fn() };
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const service = new SupportAccessService(
    ...([prisma, auditLog, sessions, accountState, logger] as unknown as ConstructorParameters<
      typeof SupportAccessService
    >),
  );
  return { service, prisma, auditLog, sessions, accountState, grantRow };
}

describe('U8 · emitir', () => {
  it('devuelve el token una vez y guarda solo su hash', async () => {
    const { service, prisma } = makeHarness();
    const issued = await service.grant(ACTOR, TENANT_ID, { reason: MOTIVO }, 'https://acme.test');

    expect(hasSupportTokenPrefix(issued.token)).toBe(true);
    const data = prisma.supportAccessGrant.create.mock.calls[0]![0].data as Record<string, unknown>;
    // El token en claro no puede aparecer en ninguna columna.
    expect(JSON.stringify(data)).not.toContain(issued.token);
    expect(data['tokenHash']).toBe(hashSupportToken(issued.token));
    expect(data['reason']).toBe(MOTIVO);
  });

  it('el enlace apunta al aula del cliente y lleva el token escapado', async () => {
    const { service } = makeHarness();
    const issued = await service.grant(ACTOR, TENANT_ID, { reason: MOTIVO }, 'https://acme.test');
    expect(issued.redeemUrl.startsWith('https://acme.test/support/access?token=')).toBe(true);
    expect(new URL(issued.redeemUrl).searchParams.get('token')).toBe(issued.token);
  });

  it('la caducidad respeta el techo aunque se pida una ventana enorme', async () => {
    const { service, prisma } = makeHarness();
    const antes = Date.now();
    await service.grant(ACTOR, TENANT_ID, { reason: MOTIVO, ttlSeconds: 99_999 }, 'https://x.test');
    const data = prisma.supportAccessGrant.create.mock.calls[0]![0].data as { expiresAt: Date };
    expect(data.expiresAt.getTime() - antes).toBeLessThanOrEqual(
      SUPPORT_ACCESS_MAX_TTL_SECONDS * 1000 + 1_000,
    );
  });

  it('queda escrito en el audit log DEL TENANT, con el motivo', async () => {
    const { service, auditLog } = makeHarness();
    await service.grant(ACTOR, TENANT_ID, { reason: MOTIVO }, 'https://x.test');
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        action: 'admin.tenant.support_access_granted',
        metadata: expect.objectContaining({ reason: MOTIVO }),
      }),
    );
  });

  it('un tenant suspendido no admite acceso de soporte', async () => {
    const { service } = makeHarness({ tenantStatus: 'SUSPENDED' });
    await expect(
      service.grant(ACTOR, TENANT_ID, { reason: MOTIVO }, 'https://x.test'),
    ).rejects.toMatchObject({ response: { code: SUPPORT_ACCESS_CODES.TENANT_UNAVAILABLE } });
  });
});

describe('U8 · canjear', () => {
  it('abre sesión con el usuario de soporte, nunca con una persona real', async () => {
    const { service, prisma, sessions } = makeHarness();
    const token = generateSupportToken();
    const result = await service.redeem(token);

    // La única búsqueda de usuario que hace es por el buzón reservado.
    for (const call of prisma.user.findFirst.mock.calls) {
      expect((call[0] as { where: { email: string } }).where.email).toBe(SUPPORT_USER_EMAIL);
    }
    expect(result.user.email).toBe(SUPPORT_USER_EMAIL);
    expect(result.user.roles).toEqual([SUPPORT_USER_ROLE]);
    expect(sessions.issueSupportAccess).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-soporte', roles: [SUPPORT_USER_ROLE], sup: 'grant-1' }),
      expect.any(Number),
      expect.anything(),
    );
  });

  it('la sesión no trae refresh token: una ventana de 15 min no se renueva', async () => {
    const { service } = makeHarness();
    const result = await service.redeem(generateSupportToken());
    expect(result).not.toHaveProperty('refreshToken');
    expect(Object.keys(result).sort()).toEqual(
      ['accessToken', 'expiresIn', 'expiresAt', 'reason', 'grantId', 'user'].sort(),
    );
  });

  it('sella la concesión con un where que impide el segundo canje', async () => {
    const { service, prisma } = makeHarness();
    await service.redeem(generateSupportToken());
    const args = prisma.supportAccessGrant.updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // El `redeemedAt: null` del where es lo que hace atómico el «un solo uso»:
    // dos canjes simultáneos y solo uno se lleva la fila.
    expect(args.where).toMatchObject({ redeemedAt: null, revokedAt: null });
    expect(args.data['sessionId']).toBe('sess-soporte');
  });

  it('si otro canje gana la carrera, la sesión recién abierta se cierra', async () => {
    const { service, prisma, accountState } = makeHarness();
    prisma.supportAccessGrant.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.redeem(generateSupportToken())).rejects.toBeInstanceOf(GoneException);
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess-soporte' } }),
    );
    expect(accountState.invalidateSession).toHaveBeenCalledWith('sess-soporte');
  });

  it('un token con otra pinta ni siquiera llega a la base de datos', async () => {
    const { service, prisma } = makeHarness();
    await expect(service.redeem('didprov_ajeno')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.supportAccessGrant.findUnique).not.toHaveBeenCalled();
  });

  it('caducada devuelve 410 y su código, no un 400 genérico', async () => {
    const { service } = makeHarness({ grant: { expiresAt: new Date(Date.now() - 1) } });
    await expect(service.redeem(generateSupportToken())).rejects.toMatchObject({
      response: { code: SUPPORT_ACCESS_CODES.EXPIRED },
    });
  });

  it('el canje también queda en el audit log del tenant', async () => {
    const { service, auditLog } = makeHarness();
    await service.redeem(generateSupportToken());
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        action: 'admin.tenant.support_access_redeemed',
      }),
    );
  });
});

describe('U8 · revocar', () => {
  it('corta la concesión y cierra su sesión en el acto', async () => {
    const { service, prisma, accountState } = makeHarness({
      grant: { redeemedAt: new Date(), sessionId: 'sess-soporte' },
    });
    const out = await service.revoke(ACTOR, TENANT_ID, 'grant-1');

    expect(out).toEqual({ revoked: true, sessionClosed: true });
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess-soporte', revokedAt: null } }),
    );
    // Sin invalidar la caché, el corte tardaría hasta 30 s en notarse.
    expect(accountState.invalidateSession).toHaveBeenCalledWith('sess-soporte');
  });

  it('revocar dos veces no rompe nada', async () => {
    const { service } = makeHarness({ grant: { revokedAt: new Date() } });
    await expect(service.revoke(ACTOR, TENANT_ID, 'grant-1')).resolves.toEqual({
      revoked: false,
      sessionClosed: false,
    });
  });

  it('una concesión de otro tenant no se revoca desde este', async () => {
    const { service, prisma } = makeHarness();
    prisma.supportAccessGrant.findFirst.mockResolvedValue(null);
    await expect(service.revoke(ACTOR, TENANT_ID, 'grant-de-otro')).rejects.toMatchObject({
      response: { code: SUPPORT_ACCESS_CODES.NOT_FOUND },
    });
    // El `tenantId` va en el where: sin él, cualquier id serviría desde cualquier tenant.
    expect(prisma.supportAccessGrant.findFirst.mock.calls[0]![0]).toMatchObject({
      where: { id: 'grant-de-otro', tenantId: TENANT_ID },
    });
  });
});

describe('U8 · el aviso del aula', () => {
  it('describeActive calla cuando la concesión ya no está viva', async () => {
    const { service, prisma } = makeHarness();
    prisma.supportAccessGrant.findFirst.mockResolvedValue(null);
    await expect(service.describeActive('grant-1')).resolves.toBeNull();
  });

  it('describeActive solo mira concesiones sin revocar y dentro de su ventana', async () => {
    const { service, prisma } = makeHarness();
    await service.describeActive('grant-1');
    const where = (
      prisma.supportAccessGrant.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }
    ).where;
    expect(where['revokedAt']).toBeNull();
    expect(where['expiresAt']).toMatchObject({ gt: expect.any(Date) });
  });
});

// ---------------------------------------------------------------------------
// Lo que NO puede pasar
// ---------------------------------------------------------------------------

/** Quita comentarios para mirar solo el código, igual que en `signup-freeze.test.ts`. */
function soloCodigo(fuente: string): string {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('///'))
    .join('\n');
}

describe('U8 · lo que NO puede pasar', () => {
  it('las reglas no conocen licencias, planes ni recuentos', () => {
    // Un acceso de soporte es infraestructura de atención al cliente, no una
    // capacidad de pago: un self-hoster lo tiene igual, para su propio equipo.
    const fuente = soloCodigo(readFileSync(FUENTE, 'utf8'));
    expect(fuente).not.toMatch(/from '@didacta\/license-sdk'/);
    expect(fuente).not.toMatch(/LicenseService|requireCapability|isCapabilityEnabled/);
    expect(fuente).not.toMatch(/\.count\(|groupBy/);
  });

  it('el techo de la ventana está escrito en el código, no en un default de columna', () => {
    // Un default de columna se cambia en una migración que nadie relee; esta
    // constante se cambia con este test en rojo.
    const migracion = readFileSync(
      join(
        process.cwd(),
        '..',
        '..',
        'packages',
        'database',
        'prisma',
        'migrations',
        '20260812140000_support_access_grant',
        'migration.sql',
      ),
      'utf8',
    );
    expect(migracion).toMatch(/CREATE TABLE "support_access_grant"/);
    expect(migracion).not.toMatch(/"expires_at"[^,]*DEFAULT/i);
  });

  it('la migración crea una tabla y no toca ninguna fila existente', () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        '..',
        '..',
        'packages',
        'database',
        'prisma',
        'migrations',
        '20260812140000_support_access_grant',
        'migration.sql',
      ),
      'utf8',
    );
    const sentencias = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    // Ninguna SENTENCIA que escriba filas. `ON UPDATE CASCADE` dentro de la FK
    // no cuenta: es la regla de la clave ajena de la tabla nueva, no un UPDATE.
    expect(sentencias).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);
    // Y ningún ALTER sobre una tabla que no sea la que acaba de nacer.
    expect(sentencias).not.toMatch(/ALTER TABLE "(?!support_access_grant")/);
  });

  it('el servicio nunca busca al usuario por otra cosa que el buzón reservado', () => {
    // La tentación evidente al mantener esto es «entra como el primer
    // tenant_admin del tenant». Eso convierte el audit log en una mentira:
    // todas las filas dirían que las hizo una persona que no estaba.
    const fuente = soloCodigo(readFileSync(SERVICIO, 'utf8'));
    const busquedas = [...fuente.matchAll(/prisma\.user\.(findFirst|findUnique|findMany)/g)];
    expect(busquedas).toHaveLength(1);
    expect(fuente).toContain('email: SUPPORT_USER_EMAIL');
  });

  it('soporte entra como tenant_admin, no como super_admin del pool entero', () => {
    // super_admin opera la INSTALACIÓN: en el pool gestionado, eso son todos
    // los demás clientes. Es exactamente lo que este acceso no debe alcanzar.
    expect(SUPPORT_USER_ROLE).toBe('tenant_admin');
  });

  it('el aula sigue avisando: el banner está montado en el shell y no se puede cerrar', () => {
    // Si alguien quita el banner, esto se pone rojo. Un acceso de soporte
    // silencioso deja de ser un favor al cliente.
    const shell = readFileSync(
      join(process.cwd(), '..', 'web', 'src', 'app', '(app)', 'layout.tsx'),
      'utf8',
    );
    expect(shell).toContain('SupportAccessBanner');

    const banner = readFileSync(
      join(process.cwd(), '..', 'web', 'src', 'components', 'support-access-banner.tsx'),
      'utf8',
    );
    // Sin botón de cerrar y sin estado que lo esconda.
    expect(banner).not.toMatch(/onDismiss|setDismissed|localStorage\.setItem/);
  });
});
