import { describe, expect, it } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminSystemController } from '../src/modules/admin-system.controller';
import { isSanctionedGlobalAccess, runAsTenant } from '../src/tenancy/tenant-context.storage';

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
  /** SMTP compartido del despliegue (env globales). */
  smtpGlobal?: boolean;
  /** Se rellena con si cada `count` corrió bajo acceso global sancionado. */
  smtpCountSanctioned?: boolean[];
  pending?: number;
  oldestAgeSeconds?: number;
  outboxThrows?: boolean;
  dispatchers?: number;
  /** `null` = sin Redis, la cola no se inicializa (dev local, y no es avería). */
  modJobsCounts?: {
    waiting?: number;
    active?: number;
    delayed?: number;
    failed?: number;
  } | null;
  modJobsWorkers?: number;
  modJobsThrows?: boolean;
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
        opts.smtpCountSanctioned?.push(isSanctionedGlobalAccess());
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
    getSmtpResolver: () => ({ hasGlobalConfig: () => opts.smtpGlobal ?? false }),
    isS3Storage: () => opts.storageKind === 's3',
    getStorage: () => ({
      ping: opts.storagePingResult !== undefined ? async () => !!opts.storagePingResult : undefined,
    }),
  };

  const counts = opts.modJobsCounts;
  const modJobs = {
    getQueue: () =>
      counts === null
        ? undefined
        : {
            async getJobCounts() {
              if (opts.modJobsThrows) throw new Error('redis down');
              return {
                waiting: counts?.waiting ?? 0,
                active: counts?.active ?? 0,
                delayed: counts?.delayed ?? 0,
                failed: counts?.failed ?? 0,
              };
            },
            async getWorkers() {
              return Array.from({ length: opts.modJobsWorkers ?? 1 }, (_, i) => ({ id: `w${i}` }));
            },
          },
  };

  return new AdminSystemController(
    prisma as never,
    outboxQueue as never,
    outboxRecovery as never,
    modules as never,
    modJobs as never,
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
    expect(r.checks.smtp.globalFallback).toBe(false);
  });

  it('con SMTP compartido del despliegue es `ready` aunque ningún aula ponga el suyo', async () => {
    const c = makeController({
      redisStatus: 'disabled',
      storageKind: 'local',
      smtpConfigured: 0,
      smtpGlobal: true,
    });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.smtp).toEqual({ status: 'ready', configuredTenants: 0, globalFallback: true });
  });

  it('sin contexto de aula (plano de control) el recuento va sancionado; con aula, acotado por RLS', async () => {
    const sanctioned: boolean[] = [];
    const c = makeController({
      redisStatus: 'ok',
      storageKind: 'local',
      smtpConfigured: 2,
      smtpCountSanctioned: sanctioned,
    });
    // Provisioning: sin sesión de aula. Antes contaba sin sanción → 0 filas
    // con RLS forzada y un error de «hueco» en el log en cada consulta.
    const r = await c.healthDetail(undefined, {
      provisioningActor: { credentialId: 'cred-1' },
    } as never);
    expect(r.checks.smtp.configuredTenants).toBe(2);
    // Control: con contexto de aula NO se sanciona (RLS acota a esa aula).
    await runAsTenant('t', () => c.healthDetail(ADMIN as never));
    expect(sanctioned).toEqual([true, false]);
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

/**
 * UC-C504 — lo que le faltaba al plano de control para operar el pool sin
 * entrar a mirar Redis a mano.
 */
describe('AdminSystemController.healthDetail · cola de módulos y versión', () => {
  it('informa de los cuatro contadores y de cuántos workers la atienden', async () => {
    const c = makeController({
      redisStatus: 'ok',
      storageKind: 'local',
      modJobsCounts: { waiting: 3, active: 1, delayed: 2, failed: 7 },
      modJobsWorkers: 2,
    });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.modJobs).toMatchObject({
      status: 'ok',
      waiting: 3,
      active: 1,
      delayed: 2,
      failed: 7,
      workers: 2,
    });
    expect(r.status).toBe('healthy');
  });

  it('acumular trabajo degrada, no tumba: el aula sigue sirviendo', async () => {
    const c = makeController({
      redisStatus: 'ok',
      storageKind: 'local',
      modJobsCounts: { waiting: 500 },
    });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.modJobs.status).toBe('backlog');
    expect(r.status).toBe('degraded');
  });

  it('sin Redis la cola sale `disabled` y NO cuenta como avería', async () => {
    // Es el estado normal de una instalación de desarrollo y de cualquiera que
    // no use módulos con trabajos en segundo plano. Marcarlo como error haría
    // que el panel del pool pintara en rojo instalaciones perfectamente sanas.
    const c = makeController({
      redisStatus: 'disabled',
      storageKind: 'local',
      modJobsCounts: null,
    });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.modJobs.status).toBe('disabled');
    expect(r.checks.modJobs.workers).toBe(0);
    expect(r.status).toBe('healthy');
  });

  it('si Redis contesta mal al contar, el estado global es unhealthy', async () => {
    const c = makeController({ redisStatus: 'ok', storageKind: 'local', modJobsThrows: true });
    const r = await c.healthDetail(ADMIN as never);
    expect(r.checks.modJobs.status).toBe('error');
    expect(r.status).toBe('unhealthy');
  });

  it('devuelve la versión que corre AHORA en el proceso', async () => {
    // El orquestador sabe qué etiqueta pidió; esto dice qué está corriendo. Es
    // la diferencia entre creer que desplegaste y saberlo, y es lo que mide el
    // lag Community → Cloud.
    //
    // La versión de prueba es deliberadamente imposible: al cortar release se
    // buscan las ocurrencias del número anterior con un grep, y una versión
    // real aquí saldría en esa lista como si fuera un sitio que hay que subir.
    const previo = process.env['DIDACTA_CORE_VERSION'];
    process.env['DIDACTA_CORE_VERSION'] = '9.9.9-solo-para-este-test';
    try {
      const c = makeController({ redisStatus: 'ok', storageKind: 'local' });
      const r = await c.healthDetail(ADMIN as never);
      expect(r.version).toBe('9.9.9-solo-para-este-test');
    } finally {
      if (previo === undefined) delete process.env['DIDACTA_CORE_VERSION'];
      else process.env['DIDACTA_CORE_VERSION'] = previo;
    }
  });

  it('la credencial de provisioning entra sin usuario; una persona sigue necesitando rol', async () => {
    const c = makeController({ redisStatus: 'ok', storageKind: 'local' });
    const req = { provisioningActor: { credentialId: 'cred-1' } };
    const r = await c.healthDetail(undefined, req as never);
    expect(r.status).toBe('healthy');

    // Sin credencial y sin rol, sigue siendo 403 — abrir la ruta a la máquina
    // no la abrió a cualquiera con sesión.
    await expect(c.healthDetail(ALUMNO as never, {} as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
