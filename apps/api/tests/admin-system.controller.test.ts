import { describe, expect, it } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminSystemController } from '../src/modules/admin-system.controller';

interface SmtpRow {
  moduleName: string;
  key: string;
  valueCipher: Buffer | null;
}

function makeController(opts: {
  dbWillThrow?: boolean;
  redisStatus?: 'ok' | 'disabled' | 'error';
  storageKind?: 's3' | 'local';
  storagePingResult?: boolean;
  smtpConfigured?: number;
  pending?: number;
  oldestAgeSeconds?: number;
  outboxThrows?: boolean;
  dispatchers?: number;
}): AdminSystemController {
  const smtpRows: SmtpRow[] = [];
  for (let i = 0; i < (opts.smtpConfigured ?? 0); i++) {
    smtpRows.push({ moduleName: 'notifications', key: 'smtp', valueCipher: Buffer.from([1, 2]) });
  }

  const prisma = {
    async $queryRaw() {
      if (opts.dbWillThrow) throw new Error('db down');
      return [{ '?column?': 1 }];
    },
    tenantSetting: {
      async count(args: { where: { moduleName: string; key: string; valueCipher: unknown } }) {
        return smtpRows.filter(
          (r) => r.moduleName === args.where.moduleName && r.key === args.where.key,
        ).length;
      },
    },
  };

  const outboxQueue = {
    isEnabled: () => opts.redisStatus !== 'disabled',
    ping: async () => opts.redisStatus === 'ok',
    countWorkers: async () => opts.dispatchers ?? 1,
  };

  const outboxRecovery = {
    sampleLag: async () => {
      if (opts.outboxThrows) throw new Error('outbox sample failed');
      return {
        pending: opts.pending ?? 0,
        oldestAgeSeconds: opts.oldestAgeSeconds ?? 0,
      };
    },
  };

  const modules = {
    isS3Storage: () => opts.storageKind === 's3',
    getStorage: () => ({
      ping: opts.storagePingResult !== undefined ? async () => !!opts.storagePingResult : undefined,
    }),
  };

  return new AdminSystemController(
    prisma as never,
    outboxQueue as never,
    outboxRecovery as never,
    modules as never,
  );
}

const ADMIN: { sub: string; tenantId: string; roles: string[] } = {
  sub: 'u',
  tenantId: 't',
  roles: ['tenant_admin'],
};
const ALUMNO = { sub: 'u', tenantId: 't', roles: ['alumno'] };

describe('AdminSystemController.healthDetail', () => {
  it('rechaza sin sesión', async () => {
    const c = makeController({});
    await expect(c.healthDetail(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza si el rol no es admin con 403', async () => {
    const c = makeController({});
    await expect(c.healthDetail(ALUMNO as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('healthy cuando todo está OK', async () => {
    const c = makeController({
      redisStatus: 'ok',
      storageKind: 's3',
      storagePingResult: true,
      smtpConfigured: 1,
      pending: 0,
      oldestAgeSeconds: 0,
    });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.status).toBe('healthy');
    expect(r.checks.db.status).toBe('ok');
    expect(r.checks.redis.status).toBe('ok');
    expect(r.checks.storage.status).toBe('ok');
    expect(r.checks.smtp.status).toBe('configured');
    expect(r.checks.outbox.status).toBe('ok');
    expect(r.checks.outbox.lagWarningThresholdSeconds).toBe(300);
  });

  it('degraded si el outbox está laggando (oldest > 5min)', async () => {
    const c = makeController({
      redisStatus: 'ok',
      storageKind: 's3',
      storagePingResult: true,
      pending: 12,
      oldestAgeSeconds: 600,
    });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.status).toBe('degraded');
    expect(r.checks.outbox.status).toBe('lagging');
    expect(r.checks.outbox.oldestPendingAgeSeconds).toBe(600);
  });

  it('unhealthy si DB falla', async () => {
    const c = makeController({ dbWillThrow: true, redisStatus: 'ok' });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.status).toBe('unhealthy');
    expect(r.checks.db.status).toBe('error');
  });

  it('unhealthy si Redis está error', async () => {
    const c = makeController({ redisStatus: 'error' });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.status).toBe('unhealthy');
    expect(r.checks.redis.status).toBe('error');
  });

  it('storage local no degrada el estado', async () => {
    const c = makeController({ redisStatus: 'disabled', storageKind: 'local' });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.storage.status).toBe('local');
    expect(r.checks.storage.kind).toBe('local-disk');
    expect(r.status).toBe('healthy');
  });

  it('smtp unconfigured cuando ningún tenant tiene credenciales', async () => {
    const c = makeController({ redisStatus: 'disabled', storageKind: 'local', smtpConfigured: 0 });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.smtp.status).toBe('unconfigured');
    expect(r.checks.smtp.configuredTenants).toBe(0);
  });

  it('outbox.error si sampleLag falla — agrega a unhealthy', async () => {
    const c = makeController({ redisStatus: 'disabled', storageKind: 'local', outboxThrows: true });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.outbox.status).toBe('error');
    expect(r.status).toBe('unhealthy');
  });

  // El número de despachadores atados a la cola del outbox se EXPONE, no se
  // juzga: con N réplicas desplegadas el valor correcto es N. Quien sabe
  // cuántos debería haber es el operador — y el arnés E2E, que exige 1.
  it('expone cuántos procesos consumen la cola del outbox', async () => {
    const c = makeController({ redisStatus: 'ok', storageKind: 'local', dispatchers: 2 });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.outbox.dispatchers).toBe(2);
    // Dos consumidores no son un error del sistema: es el dato que permite
    // detectarlo a quien sí sabe cuántos esperaba.
    expect(r.checks.outbox.status).toBe('ok');
  });

  it('dispatchers=0 cuando el despachador no está atado', async () => {
    const c = makeController({ redisStatus: 'disabled', storageKind: 'local', dispatchers: 0 });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.outbox.dispatchers).toBe(0);
  });
});
