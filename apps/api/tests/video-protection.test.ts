import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSensitiveFields } from '../src/modules/redact-sensitive-fields';
import {
  BUNNY_GUID_RE,
  PLAY_URL_TTL_SECONDS,
  bunnyEmbedToken,
  signBunnyEmbedUrl,
} from '../src/video/bunny-embed';
import { VideoAccessService } from '../src/video/video-access.service';
import { VideoPlayLimiter, type VideoPlayRedisClient } from '../src/video/video-play-limiter';
import {
  VideoForbiddenError,
  VideoPlaybackService,
  VideoRateLimitedError,
} from '../src/video/video-playback.service';
import { VideoProtectionAdminController } from '../src/video/video-protection-admin.controller';
import {
  BUNNY_CHECKS_SETTING,
  BUNNY_KEYS_SETTING,
  DEFAULT_VIDEO_PROTECTION_SETTINGS,
  VIDEO_PROTECTION_SCOPE,
  VIDEO_SETTINGS_SETTING,
  VideoProtectionConfigService,
  normalizeVideoProtectionSettings,
} from '../src/video/video-protection-config.service';
import { checkBunnySignature, looksLikeBunnyPlayer } from '../src/video/video-signature-check';
import { VideoController } from '../src/video/video.controller';

/**
 * Protección de vídeo de Bunny Stream: firma con caducidad, autorización por
 * vídeo, tope por cuenta y configuración por tenant.
 *
 * Los identificadores son inventados (no son de ninguna librería real) y la
 * firma se contrasta con vectores calculados FUERA de este código (openssl,
 * sha256sum y hashlib dieron lo mismo), no con la propia función.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const GUID = '0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b';
const LIB = '100200';
const KEY = 'clave-de-pruebas-de-la-libreria';

/** `printf '%s' "<KEY><GUID>1900000000" | openssl dgst -sha256` */
const TOKEN_KEY_1900000000 = 'b3792a1da2c2f43f1143a51e0a117c3a26d39ae80a7a86a5b1f82219a225356f';
/** Lo mismo con la clave `otra-clave-distinta`: el control de que la clave importa. */
const TOKEN_OTHER_KEY_1900000000 =
  '32dddf34fc335d656c7263be6f95e511a82fb3245970929a98d714425ef07596';

const alumno = { tenantId: TENANT_A, userId: USER, roles: ['alumno'] };

// ─────────────────────────────── firma ───────────────────────────────

describe('signBunnyEmbedUrl', () => {
  it('firma con SHA256_HEX(clave + guid + expires) — vector calculado con openssl', () => {
    const r = signBunnyEmbedUrl({
      libraryId: LIB,
      guid: GUID,
      tokenKey: KEY,
      now: new Date((1900000000 - PLAY_URL_TTL_SECONDS) * 1000),
    });
    expect(r.url).toBe(
      `https://iframe.mediadelivery.net/embed/${LIB}/${GUID}?token=${TOKEN_KEY_1900000000}&expires=1900000000`,
    );
    expect(r.expiresAt).toBe(new Date(1900000000 * 1000).toISOString());
  });

  it('CONTROL: otra clave da otro token para el mismo vídeo y la misma caducidad', () => {
    expect(bunnyEmbedToken('otra-clave-distinta', GUID, 1900000000)).toBe(
      TOKEN_OTHER_KEY_1900000000,
    );
    expect(TOKEN_OTHER_KEY_1900000000).not.toBe(TOKEN_KEY_1900000000);
  });

  it('caduca a los 30 minutos y `expires` va en SEGUNDOS (Bunny no admite ms)', () => {
    const now = new Date('2030-01-01T10:00:00.900Z');
    const r = signBunnyEmbedUrl({ libraryId: LIB, guid: GUID, tokenKey: KEY, now });
    const expires = Number(new URL(r.url).searchParams.get('expires'));
    expect(expires).toBe(Math.floor(now.getTime() / 1000) + 30 * 60);
    expect(String(expires)).toHaveLength(10);
    expect(r.expiresAt).toBe('2030-01-01T10:30:00.000Z');
  });

  it('el token depende de la caducidad: una URL vieja no vale para otro momento', () => {
    expect(bunnyEmbedToken(KEY, GUID, 1900000001)).not.toBe(TOKEN_KEY_1900000000);
  });

  it('el token depende del vídeo: la firma de uno no abre otro', () => {
    expect(bunnyEmbedToken(KEY, '0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0c', 1900000000)).not.toBe(
      TOKEN_KEY_1900000000,
    );
  });

  it('sin clave devuelve la URL sin firmar y expiresAt null', () => {
    expect(signBunnyEmbedUrl({ libraryId: LIB, guid: GUID, tokenKey: null })).toEqual({
      url: `https://iframe.mediadelivery.net/embed/${LIB}/${GUID}`,
      expiresAt: null,
    });
  });

  it('el GUID se valida por forma, sin exigir versión de UUID', () => {
    expect(BUNNY_GUID_RE.test(GUID)).toBe(true);
    expect(BUNNY_GUID_RE.test('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(BUNNY_GUID_RE.test(`${GUID}%`)).toBe(false);
    expect(BUNNY_GUID_RE.test('no-es-un-guid')).toBe(false);
  });
});

// ───────────────────────── configuración por tenant ─────────────────────────

/** `PrismaTenantConfigService` en memoria: cada tenant ve solo lo suyo. */
function makeConfigStub() {
  const store = new Map<string, { value: unknown; isSecret: boolean }>();
  const k = (t: string, m: string, key: string) => `${t}|${m}|${key}`;
  return {
    store,
    get: vi.fn(async (t: string, m: string, key: string) => store.get(k(t, m, key))?.value),
    set: vi.fn(
      async (t: string, m: string, key: string, v: unknown, opts?: { isSecret?: boolean }) => {
        store.set(k(t, m, key), { value: v, isSecret: opts?.isSecret ?? false });
      },
    ),
  };
}

/** Prisma mínimo para las consultas crudas del servicio de configuración. */
function makeRawPrisma(rowsByCall: unknown[][] = []) {
  const queue = [...rowsByCall];
  const prisma = {
    $queryRaw: vi.fn(() => Promise.resolve(queue.shift() ?? [])),
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  return prisma;
}

function makeConfigService(rowsByCall: unknown[][] = []) {
  const config = makeConfigStub();
  const prisma = makeRawPrisma(rowsByCall);
  const service = new VideoProtectionConfigService(config as never, prisma as never);
  return { service, config, prisma };
}

describe('normalizeVideoProtectionSettings', () => {
  it('sin nada guardado: los valores por defecto (activo, 30/h, 100/día, con marca)', () => {
    expect(normalizeVideoProtectionSettings(undefined)).toEqual({
      enabled: true,
      maxVideosPerHour: 30,
      maxVideosPerDay: 100,
      watermark: true,
    });
    expect(normalizeVideoProtectionSettings(undefined)).toEqual(DEFAULT_VIDEO_PROTECTION_SETTINGS);
  });

  it('un campo inválido cae a su valor por defecto sin arrastrar a los demás', () => {
    expect(
      normalizeVideoProtectionSettings({
        enabled: false,
        watermark: 'sí',
        maxVideosPerHour: '12',
        maxVideosPerDay: 250,
      }),
    ).toEqual({ enabled: false, watermark: true, maxVideosPerHour: 30, maxVideosPerDay: 250 });
  });

  it('un tope a 0, negativo o descomunal se acota: nunca deja a un tenant sin vídeos', () => {
    const low = normalizeVideoProtectionSettings({ maxVideosPerHour: 0, maxVideosPerDay: -5 });
    expect(low.maxVideosPerHour).toBe(1);
    expect(low.maxVideosPerDay).toBe(1);
    const high = normalizeVideoProtectionSettings({
      maxVideosPerHour: 10 ** 9,
      maxVideosPerDay: 10 ** 9,
    });
    expect(high.maxVideosPerHour).toBe(1_000);
    expect(high.maxVideosPerDay).toBe(10_000);
  });

  it('el tope diario nunca queda por debajo del horario', () => {
    expect(
      normalizeVideoProtectionSettings({ maxVideosPerHour: 50, maxVideosPerDay: 10 })
        .maxVideosPerDay,
    ).toBe(50);
  });

  it('basura (array, cadena, null) → valores por defecto', () => {
    for (const raw of [[], 'x', null, 7]) {
      expect(normalizeVideoProtectionSettings(raw)).toEqual(DEFAULT_VIDEO_PROTECTION_SETTINGS);
    }
  });
});

describe('VideoProtectionConfigService', () => {
  it('un tenant que no ha configurado nada no tiene protección activa', async () => {
    const { service } = makeConfigService();
    expect(await service.resolveLibrary(TENANT_A, LIB)).toEqual({
      active: false,
      tokenKey: null,
      settings: DEFAULT_VIDEO_PROTECTION_SETTINGS,
    });
  });

  it('guarda la clave cifrada, por librería, conservando las de las demás', async () => {
    const { service, config } = makeConfigService();
    await service.setTokenKey(TENANT_A, USER, '555', 'clave-de-otra-libreria');
    await service.setTokenKey(TENANT_A, USER, LIB, KEY);

    expect(config.set).toHaveBeenLastCalledWith(
      TENANT_A,
      VIDEO_PROTECTION_SCOPE,
      BUNNY_KEYS_SETTING,
      {
        libraries: {
          '555': { signingSecret: 'clave-de-otra-libreria' },
          [LIB]: { signingSecret: KEY },
        },
      },
      { isSecret: true, actorId: USER },
    );
    expect((await service.resolveLibrary(TENANT_A, LIB)).tokenKey).toBe(KEY);
    expect((await service.resolveLibrary(TENANT_A, '555')).tokenKey).toBe('clave-de-otra-libreria');
  });

  it('lo guardado sale REDACTADO por el GET genérico de /tenant-settings', async () => {
    const { service, config } = makeConfigService();
    await service.setTokenKey(TENANT_A, USER, LIB, KEY);
    const stored = config.store.get(`${TENANT_A}|${VIDEO_PROTECTION_SCOPE}|${BUNNY_KEYS_SETTING}`);
    expect(stored?.isSecret).toBe(true);

    const redacted = redactSensitiveFields(stored!.value as Record<string, unknown>);
    expect(JSON.stringify(redacted)).not.toContain(KEY);
    expect(redacted).toEqual({ libraries: { [LIB]: { signingSecret: null } } });

    // CONTROL: con un mapa plano `{ [libraryId]: clave }` ese mismo endpoint la
    // devolvería en claro. Por eso la forma guardada no es esa.
    expect(JSON.stringify(redactSensitiveFields({ [LIB]: KEY }))).toContain(KEY);
  });

  it('AISLAMIENTO: la clave de un tenant no existe para otro (ni por la caché)', async () => {
    const { service } = makeConfigService();
    await service.setTokenKey(TENANT_A, USER, LIB, KEY);

    // Primero A, para que su clave quede en la caché del proceso…
    expect((await service.resolveLibrary(TENANT_A, LIB)).active).toBe(true);
    // …y B pregunta por la MISMA librería: no hereda nada.
    expect(await service.resolveLibrary(TENANT_B, LIB)).toEqual({
      active: false,
      tokenKey: null,
      settings: DEFAULT_VIDEO_PROTECTION_SETTINGS,
    });
    expect(await service.getTokenKey(TENANT_B, LIB)).toBeNull();
  });

  it('AISLAMIENTO: cada tenant tiene su interruptor, su tope y su marca de agua', async () => {
    const { service } = makeConfigService();
    await service.updateSettings(TENANT_A, USER, {
      maxVideosPerHour: 5,
      maxVideosPerDay: 9,
      watermark: false,
    });
    expect(await service.getSettings(TENANT_A)).toEqual({
      enabled: true,
      maxVideosPerHour: 5,
      maxVideosPerDay: 9,
      watermark: false,
    });
    expect(await service.getSettings(TENANT_B)).toEqual(DEFAULT_VIDEO_PROTECTION_SETTINGS);
  });

  it('con la protección apagada la clave se conserva pero la librería deja de estar activa', async () => {
    const { service } = makeConfigService();
    await service.setTokenKey(TENANT_A, USER, LIB, KEY);
    await service.updateSettings(TENANT_A, USER, { enabled: false });

    const off = await service.resolveLibrary(TENANT_A, LIB);
    expect(off.active).toBe(false);
    expect(off.tokenKey).toBe(KEY);

    await service.updateSettings(TENANT_A, USER, { enabled: true });
    expect((await service.resolveLibrary(TENANT_A, LIB)).active).toBe(true);
  });

  it('cachea un minuto por tenant y se invalida al guardar', async () => {
    const { service, config } = makeConfigService();
    await service.resolveLibrary(TENANT_A, LIB);
    const readsAfterFirst = config.get.mock.calls.length;
    await service.resolveLibrary(TENANT_A, LIB);
    await service.resolveLibrary(TENANT_A, '555');
    expect(config.get.mock.calls.length).toBe(readsAfterFirst);

    await service.setTokenKey(TENANT_A, USER, LIB, KEY);
    expect((await service.resolveLibrary(TENANT_A, LIB)).active).toBe(true);
  });

  it('una clave guardada que ya no se descifra no tumba los vídeos y se puede volver a guardar', async () => {
    const { service, config } = makeConfigService();
    config.get.mockImplementation(async (_t: string, _m: string, key: string) => {
      if (key === BUNNY_KEYS_SETTING) {
        throw new Error('Unsupported state or unable to authenticate data');
      }
      return undefined;
    });

    expect((await service.resolveLibrary(TENANT_A, LIB)).active).toBe(false);
    await service.setTokenKey(TENANT_A, USER, LIB, 'clave-nueva-tras-rotar');
    expect(config.set).toHaveBeenCalledWith(
      TENANT_A,
      VIDEO_PROTECTION_SCOPE,
      BUNNY_KEYS_SETTING,
      { libraries: { [LIB]: { signingSecret: 'clave-nueva-tras-rotar' } } },
      { isSecret: true, actorId: USER },
    );
  });

  it('ignora lo que no tenga forma de clave (JSON escrito a mano por el endpoint genérico)', async () => {
    const { service, config } = makeConfigService();
    config.store.set(`${TENANT_A}|${VIDEO_PROTECTION_SCOPE}|${BUNNY_KEYS_SETTING}`, {
      isSecret: true,
      value: {
        libraries: {
          [LIB]: { signingSecret: KEY },
          'no-es-un-id': { signingSecret: 'x' },
          '777': { signingSecret: 42 },
          '888': null,
        },
      },
    });
    expect((await service.resolveLibrary(TENANT_A, LIB)).tokenKey).toBe(KEY);
    expect(await service.getTokenKey(TENANT_A, '777')).toBeNull();
    expect(await service.getTokenKey(TENANT_A, '888')).toBeNull();
  });

  it('el estado lista las librerías en uso y las configuradas, ordenadas y SIN claves', async () => {
    // 1ª consulta cruda: librerías que aparecen en los cursos del tenant.
    const { service, prisma } = makeConfigService([[{ lib: '9000' }, { lib: LIB }, { lib: null }]]);
    await service.setTokenKey(TENANT_A, USER, LIB, KEY);
    await service.setTokenKey(TENANT_A, USER, '42', 'clave-de-una-libreria-sin-uso');
    await service.recordCheck(TENANT_A, USER, LIB, {
      outcome: 'ok',
      checkedAt: '2030-01-01T10:00:00.000Z',
    });

    const status = await service.status(TENANT_A);
    expect(status).toEqual({
      enabled: true,
      active: true,
      watermark: true,
      limits: { perHour: 30, perDay: 100 },
      libraries: [
        // Orden numérico (42 < 9000 < 100200), no alfabético.
        { libraryId: '42', configured: true, inUse: false, lastCheck: null },
        { libraryId: '9000', configured: false, inUse: true, lastCheck: null },
        {
          libraryId: LIB,
          configured: true,
          inUse: true,
          lastCheck: { outcome: 'ok', checkedAt: '2030-01-01T10:00:00.000Z' },
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain(KEY);
    // La consulta cruda va SIEMPRE dentro de un $transaction por lotes: suelta
    // correría sin contexto de tenant y RLS no le dejaría ver nada.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(Array.isArray(prisma.$transaction.mock.calls[0]![0])).toBe(true);
  });

  it('`active` es false sin ninguna clave, y también con la protección apagada', async () => {
    const { service } = makeConfigService([[{ lib: LIB }], [{ lib: LIB }]]);
    expect((await service.status(TENANT_A)).active).toBe(false);
    await service.setTokenKey(TENANT_A, USER, LIB, KEY);
    await service.updateSettings(TENANT_A, USER, { enabled: false });
    const status = await service.status(TENANT_A);
    expect(status.enabled).toBe(false);
    expect(status.active).toBe(false);
  });

  it('cambiar la clave de una librería olvida su última comprobación', async () => {
    const { service, config } = makeConfigService();
    await service.setTokenKey(TENANT_A, USER, LIB, KEY);
    await service.recordCheck(TENANT_A, USER, LIB, {
      outcome: 'ok',
      checkedAt: '2030-01-01T10:00:00.000Z',
    });
    await service.recordCheck(TENANT_A, USER, '555', {
      outcome: 'rejected',
      checkedAt: '2030-01-01T10:00:00.000Z',
    });
    await service.setTokenKey(TENANT_A, USER, LIB, 'clave-regenerada-en-bunny');

    expect(
      config.store.get(`${TENANT_A}|${VIDEO_PROTECTION_SCOPE}|${BUNNY_CHECKS_SETTING}`)?.value,
    ).toEqual({ '555': { outcome: 'rejected', checkedAt: '2030-01-01T10:00:00.000Z' } });
  });

  it('findSampleVideo devuelve un GUID del propio tenant, en minúsculas, o null', async () => {
    const { service, prisma } = makeConfigService([
      [{ guid: null }, { guid: 'no-vale' }, { guid: GUID.toUpperCase() }],
      [],
    ]);
    expect(await service.findSampleVideo(TENANT_A, LIB)).toBe(GUID);
    expect(await service.findSampleVideo(TENANT_A, LIB)).toBeNull();
    // Un library ID que no son dígitos ni llega a la base de datos.
    expect(await service.findSampleVideo(TENANT_A, "1'; DROP TABLE x; --")).toBeNull();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('los ajustes se guardan sin cifrar y normalizados', async () => {
    const { service, config } = makeConfigService();
    await service.updateSettings(TENANT_A, USER, { maxVideosPerHour: 40, maxVideosPerDay: 10 });
    expect(config.set).toHaveBeenCalledWith(
      TENANT_A,
      VIDEO_PROTECTION_SCOPE,
      VIDEO_SETTINGS_SETTING,
      { enabled: true, watermark: true, maxVideosPerHour: 40, maxVideosPerDay: 40 },
      { isSecret: false, actorId: USER },
    );
  });
});

// ─────────────────────────── autorización ───────────────────────────

function accessHarness(
  opts: {
    featured?: boolean;
    lessons?: Array<{ lessonId: string; courseId: string }>;
    coursePublished?: boolean;
    enrolled?: boolean;
    availability?: { drip: boolean; lessons: Record<string, { available: boolean }> };
  } = {},
) {
  const prisma = {
    modCoursesCourse: {
      findFirst: vi.fn(async (args: { where: { featuredVideoUrl?: unknown } }) => {
        if (args.where.featuredVideoUrl) return opts.featured ? { id: 'c-featured' } : null;
        return opts.coursePublished === false ? null : { id: 'c1' };
      }),
    },
    $queryRaw: vi.fn(() => Promise.resolve(opts.lessons ?? [])),
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  const learning = {
    hasActiveEnrollment: vi.fn(async () => opts.enrolled ?? false),
    getCourseAvailability: vi.fn(async () => opts.availability ?? { drip: false, lessons: {} }),
  };
  const registry = { getLearningService: () => learning };
  const service = new VideoAccessService(prisma as never, registry as never);
  return { service, prisma, learning };
}

describe('VideoAccessService.canPlay', () => {
  it('quien gestiona cursos puede ver cualquier vídeo sin consultar nada', async () => {
    for (const role of ['formador', 'tenant_admin', 'super_admin']) {
      const { service, prisma } = accessHarness();
      expect(await service.canPlay({ ...alumno, roles: [role] }, GUID)).toBe(true);
      expect(prisma.modCoursesCourse.findFirst).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    }
  });

  it('el vídeo destacado de un curso publicado lo ve cualquiera del aula (es el escaparate)', async () => {
    const { service, prisma, learning } = accessHarness({ featured: true });
    expect(await service.canPlay(alumno, GUID)).toBe(true);
    expect(prisma.modCoursesCourse.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT_A, status: 'PUBLISHED' }),
      }),
    );
    expect(learning.hasActiveEnrollment).not.toHaveBeenCalled();
  });

  it('una lección: con matrícula viva → sí', async () => {
    const { service, learning } = accessHarness({
      lessons: [{ lessonId: 'l1', courseId: 'c1' }],
      enrolled: true,
    });
    expect(await service.canPlay(alumno, GUID)).toBe(true);
    expect(learning.hasActiveEnrollment).toHaveBeenCalledWith(TENANT_A, USER, 'c1');
  });

  it('una lección: SIN matrícula → no, aunque conozca el GUID', async () => {
    const { service } = accessHarness({
      lessons: [{ lessonId: 'l1', courseId: 'c1' }],
      enrolled: false,
    });
    expect(await service.canPlay(alumno, GUID)).toBe(false);
  });

  it('una lección: curso en borrador o archivado → no, aunque haya matrícula', async () => {
    const { service, learning } = accessHarness({
      lessons: [{ lessonId: 'l1', courseId: 'c1' }],
      enrolled: true,
      coursePublished: false,
    });
    expect(await service.canPlay(alumno, GUID)).toBe(false);
    expect(learning.hasActiveEnrollment).not.toHaveBeenCalled();
  });

  it('una lección aún bloqueada (drip, fecha o periodo de prueba) → no', async () => {
    const { service } = accessHarness({
      lessons: [{ lessonId: 'l1', courseId: 'c1' }],
      enrolled: true,
      availability: { drip: true, lessons: { l1: { available: false } } },
    });
    expect(await service.canPlay(alumno, GUID)).toBe(false);
  });

  it('el mismo vídeo en dos lecciones: basta con que UNA esté disponible', async () => {
    const { service } = accessHarness({
      lessons: [
        { lessonId: 'l1', courseId: 'c1' },
        { lessonId: 'l2', courseId: 'c1' },
      ],
      enrolled: true,
      availability: { drip: true, lessons: { l1: { available: false } } },
    });
    expect(await service.canPlay(alumno, GUID)).toBe(true);
  });

  it('un GUID que no aparece en ningún sitio → no (conocerlo no basta)', async () => {
    const { service } = accessHarness();
    expect(await service.canPlay(alumno, GUID)).toBe(false);
  });

  it('algo que no tiene forma de GUID no llega a la base de datos', async () => {
    const { service, prisma } = accessHarness({ featured: true });
    expect(await service.canPlay(alumno, '%')).toBe(false);
    expect(await service.canPlay(alumno, `${GUID}' OR 1=1 --`)).toBe(false);
    expect(prisma.modCoursesCourse.findFirst).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('la búsqueda en lecciones va en un $transaction por lotes (si no, RLS la deja a cero)', async () => {
    const { service, prisma } = accessHarness({
      lessons: [{ lessonId: 'l1', courseId: 'c1' }],
      enrolled: true,
    });
    await service.canPlay(alumno, GUID);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(Array.isArray(prisma.$transaction.mock.calls[0]![0])).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('AISLAMIENTO: toda consulta va filtrada por el tenant de quien pregunta', async () => {
    const { service, prisma, learning } = accessHarness({
      lessons: [{ lessonId: 'l1', courseId: 'c1' }],
      enrolled: true,
    });
    await service.canPlay({ tenantId: TENANT_B, userId: USER, roles: ['alumno'] }, GUID);

    for (const [args] of prisma.modCoursesCourse.findFirst.mock.calls) {
      expect((args as { where: { tenantId: string } }).where.tenantId).toBe(TENANT_B);
    }
    // Los valores enlazados de la consulta cruda: tenant (dos veces) y el patrón.
    const rawCall = prisma.$queryRaw.mock.calls[0] as unknown as unknown[];
    expect(rawCall.slice(1)).toEqual([TENANT_B, TENANT_B, `%${GUID}%`]);
    expect(learning.hasActiveEnrollment).toHaveBeenCalledWith(TENANT_B, USER, 'c1');
  });

  it('AISLAMIENTO: el «sí» cacheado de un tenant no vale para el mismo usuario en otro', async () => {
    const { service, prisma } = accessHarness({ featured: true });
    expect(await service.canPlay(alumno, GUID)).toBe(true);

    prisma.modCoursesCourse.findFirst.mockResolvedValue(null);
    // Mismo userId y mismo vídeo, otra academia: se vuelve a preguntar y es «no».
    expect(await service.canPlay({ ...alumno, tenantId: TENANT_B }, GUID)).toBe(false);
    // Y el de A sigue en caché.
    expect(await service.canPlay(alumno, GUID)).toBe(true);
  });

  it('el «no» no se cachea: recién matriculado lo ve al instante', async () => {
    const { service, learning } = accessHarness({
      lessons: [{ lessonId: 'l1', courseId: 'c1' }],
      enrolled: false,
    });
    expect(await service.canPlay(alumno, GUID)).toBe(false);
    learning.hasActiveEnrollment.mockResolvedValue(true);
    expect(await service.canPlay(alumno, GUID)).toBe(true);
  });

  it('cachea el «sí»: el segundo intento no consulta', async () => {
    const { service, prisma } = accessHarness({ featured: true });
    await service.canPlay(alumno, GUID);
    await service.canPlay(alumno, GUID.toUpperCase());
    expect(prisma.modCoursesCourse.findFirst).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────── tope ───────────────────────────────

function guidN(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const DEFAULT_LIMITS = { perHour: 30, perDay: 100 };

/** ZSET de Redis mínimo, para probar el camino Redis sin servidor. */
function fakeRedis(): VideoPlayRedisClient {
  const sets = new Map<string, Map<string, number>>();
  const z = (key: string) => {
    let s = sets.get(key);
    if (!s) sets.set(key, (s = new Map()));
    return s;
  };
  /** Cota de Redis: `-inf`, `+inf`, número (inclusiva) o `(número` (exclusiva). */
  const inRange = (score: number, min: string | number, max: string | number) => {
    const bound = (v: string | number): { value: number; exclusive: boolean } => {
      if (v === '-inf') return { value: -Infinity, exclusive: false };
      if (v === '+inf') return { value: Infinity, exclusive: false };
      const text = String(v);
      return text.startsWith('(')
        ? { value: Number(text.slice(1)), exclusive: true }
        : { value: Number(text), exclusive: false };
    };
    const lo = bound(min);
    const hi = bound(max);
    return (
      (lo.exclusive ? score > lo.value : score >= lo.value) &&
      (hi.exclusive ? score < hi.value : score <= hi.value)
    );
  };
  return {
    zremrangebyscore: async (key, min, max) => {
      let n = 0;
      for (const [member, score] of z(key))
        if (inRange(score, min, max)) {
          z(key).delete(member);
          n++;
        }
      return n;
    },
    zscore: async (key, member) => (z(key).has(member) ? String(z(key).get(member)) : null),
    zcard: async (key) => z(key).size,
    zcount: async (key, min, max) =>
      [...z(key).values()].filter((score) => inRange(score, min, max)).length,
    zrangebyscore: async (key, min, max) => {
      const first = [...z(key).entries()]
        .filter(([, score]) => inRange(score, min, max))
        .sort((a, b) => a[1] - b[1])[0];
      return first ? [first[0], String(first[1])] : [];
    },
    zadd: async (key, _nx, score, member) => {
      if (z(key).has(member)) return 0;
      z(key).set(member, score);
      return 1;
    },
    expire: async () => 1,
  };
}

describe.each([
  ['memoria', () => new VideoPlayLimiter(null)],
  ['redis', () => new VideoPlayLimiter(fakeRedis())],
])('VideoPlayLimiter (%s)', (_name, make) => {
  const t0 = Date.UTC(2030, 0, 15, 6, 0, 0);

  it('deja 30 vídeos distintos en una hora y corta el 31.º diciendo cuándo volver', async () => {
    const limiter = make();
    for (let i = 0; i < 30; i++) {
      expect(
        (await limiter.check(TENANT_A, USER, guidN(i), DEFAULT_LIMITS, t0 + i * 1000)).allowed,
      ).toBe(true);
    }
    const over = await limiter.check(TENANT_A, USER, guidN(999), DEFAULT_LIMITS, t0 + 60_000);
    expect(over).toEqual({ allowed: false, window: 'hour', limit: 30, retryAfterSeconds: 3540 });
  });

  it('repetir un vídeo ya abierto no cuenta (saltos de capítulo, recargas)', async () => {
    const limiter = make();
    for (let i = 0; i < 30; i++) {
      await limiter.check(TENANT_A, USER, guidN(i), DEFAULT_LIMITS, t0 + i);
    }
    expect(
      (await limiter.check(TENANT_A, USER, guidN(3), DEFAULT_LIMITS, t0 + 5_000)).allowed,
    ).toBe(true);
  });

  it('corta al pasar de 100 distintos en 24 h aunque vayan espaciados', async () => {
    const limiter = make();
    // 10 por hora durante 10 horas: nunca toca el tope horario.
    for (let i = 0; i < 100; i++) {
      const at = t0 + Math.floor(i / 10) * 3_600_000 + (i % 10) * 1000;
      expect((await limiter.check(TENANT_A, USER, guidN(i), DEFAULT_LIMITS, at)).allowed).toBe(
        true,
      );
    }
    const over = await limiter.check(
      TENANT_A,
      USER,
      guidN(999),
      DEFAULT_LIMITS,
      t0 + 11 * 3_600_000,
    );
    expect(over).toMatchObject({ allowed: false, window: 'day', limit: 100 });
  });

  it('pasada la hora vuelve a dejar abrir vídeos nuevos', async () => {
    const limiter = make();
    for (let i = 0; i < 30; i++) {
      await limiter.check(TENANT_A, USER, guidN(i), DEFAULT_LIMITS, t0);
    }
    expect(
      (await limiter.check(TENANT_A, USER, guidN(50), DEFAULT_LIMITS, t0 + 1000)).allowed,
    ).toBe(false);
    // Justo una hora después del primero: ya no cuenta ninguno de los 30.
    expect(
      (await limiter.check(TENANT_A, USER, guidN(50), DEFAULT_LIMITS, t0 + 3_600_000)).allowed,
    ).toBe(true);
  });

  it('el tope lo pone el tenant: con 2 por hora, el 3.º se corta', async () => {
    const limiter = make();
    const limits = { perHour: 2, perDay: 100 };
    expect((await limiter.check(TENANT_A, USER, guidN(1), limits, t0)).allowed).toBe(true);
    expect((await limiter.check(TENANT_A, USER, guidN(2), limits, t0 + 1)).allowed).toBe(true);
    expect(await limiter.check(TENANT_A, USER, guidN(3), limits, t0 + 2)).toMatchObject({
      allowed: false,
      window: 'hour',
      limit: 2,
    });
  });

  it('el tope es por cuenta: otro usuario no se ve afectado', async () => {
    const limiter = make();
    for (let i = 0; i <= 30; i++) {
      await limiter.check(TENANT_A, USER, guidN(i), DEFAULT_LIMITS, t0 + i);
    }
    expect((await limiter.check(TENANT_A, USER, guidN(77), DEFAULT_LIMITS, t0 + 100)).allowed).toBe(
      false,
    );
    expect(
      (await limiter.check(TENANT_A, 'otro-usuario', guidN(0), DEFAULT_LIMITS, t0 + 100)).allowed,
    ).toBe(true);
  });

  it('AISLAMIENTO: el mismo id de usuario en otra academia tiene su propio contador', async () => {
    const limiter = make();
    for (let i = 0; i <= 30; i++) {
      await limiter.check(TENANT_A, USER, guidN(i), DEFAULT_LIMITS, t0 + i);
    }
    expect((await limiter.check(TENANT_A, USER, guidN(77), DEFAULT_LIMITS, t0 + 100)).allowed).toBe(
      false,
    );
    expect((await limiter.check(TENANT_B, USER, guidN(77), DEFAULT_LIMITS, t0 + 100)).allowed).toBe(
      true,
    );
  });
});

describe('VideoPlayLimiter sin Redis disponible', () => {
  it('si Redis falla cae a memoria y SIGUE cortando (no deja la puerta abierta)', async () => {
    const broken = new Proxy({} as VideoPlayRedisClient, {
      get: () => async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const limiter = new VideoPlayLimiter(broken);
    const limits = { perHour: 1, perDay: 5 };
    expect((await limiter.check(TENANT_A, USER, guidN(1), limits, 1000)).allowed).toBe(true);
    expect((await limiter.check(TENANT_A, USER, guidN(2), limits, 2000)).allowed).toBe(false);
  });
});

// ───────────────────────────── playback ─────────────────────────────

function playbackHarness(
  opts: {
    canPlay?: boolean;
    limited?: boolean;
    /** Claves por tenant y librería ya guardadas. */
    keys?: Record<string, Record<string, string>>;
    settings?: Record<string, Partial<typeof DEFAULT_VIDEO_PROTECTION_SETTINGS>>;
  } = {},
) {
  const access = { canPlay: vi.fn(async () => opts.canPlay ?? true) };
  const config = {
    resolveLibrary: vi.fn(async (tenantId: string, libraryId: string) => {
      const settings = { ...DEFAULT_VIDEO_PROTECTION_SETTINGS, ...opts.settings?.[tenantId] };
      const tokenKey = opts.keys?.[tenantId]?.[libraryId] ?? null;
      return { active: settings.enabled && tokenKey !== null, tokenKey, settings };
    }),
  };
  const limiter = {
    check: vi.fn(async () =>
      opts.limited
        ? { allowed: false as const, window: 'hour' as const, limit: 30, retryAfterSeconds: 120 }
        : { allowed: true as const },
    ),
  };
  const auditLog = { record: vi.fn(async () => undefined) };
  const service = new VideoPlaybackService(
    access as never,
    config as never,
    limiter as never,
    auditLog as never,
  );
  return { service, access, config, limiter, auditLog };
}

/** Lo que haría Bunny para aceptar o rechazar la URL: recalcular el hash con SU clave. */
function bunnyWouldAccept(url: string, libraryKey: string, nowMs = Date.now()): boolean {
  const parsed = new URL(url);
  const guid = parsed.pathname.split('/').pop() ?? '';
  const token = parsed.searchParams.get('token');
  const expires = parsed.searchParams.get('expires');
  if (!token || !expires) return false;
  if (Number(expires) * 1000 <= nowMs) return false;
  return createHash('sha256').update(`${libraryKey}${guid}${expires}`).digest('hex') === token;
}

describe('VideoPlaybackService.getPlayUrl', () => {
  const UNSIGNED = `https://iframe.mediadelivery.net/embed/${LIB}/${GUID}`;

  it('COMPATIBILIDAD: sin clave, la URL de siempre — sin firma, sin comprobar acceso y sin tope', async () => {
    const h = playbackHarness({ canPlay: false, limited: true });
    expect(await h.service.getPlayUrl(alumno, LIB, GUID)).toEqual({
      url: UNSIGNED,
      expiresAt: null,
      protected: false,
      watermark: false,
    });
    expect(h.access.canPlay).not.toHaveBeenCalled();
    expect(h.limiter.check).not.toHaveBeenCalled();
  });

  it('con la protección apagada por el admin, igual que sin clave', async () => {
    const h = playbackHarness({
      canPlay: false,
      keys: { [TENANT_A]: { [LIB]: KEY } },
      settings: { [TENANT_A]: { enabled: false } },
    });
    expect(await h.service.getPlayUrl(alumno, LIB, GUID)).toEqual({
      url: UNSIGNED,
      expiresAt: null,
      protected: false,
      watermark: false,
    });
    expect(h.access.canPlay).not.toHaveBeenCalled();
  });

  it('una librería sin clave no queda protegida aunque el tenant tenga clave en otra', async () => {
    const h = playbackHarness({ keys: { [TENANT_A]: { '555': 'clave-de-otra-libreria' } } });
    expect((await h.service.getPlayUrl(alumno, LIB, GUID)).protected).toBe(false);
    expect((await h.service.getPlayUrl(alumno, '555', GUID)).protected).toBe(true);
  });

  it('PERMISO DENEGADO: sin derecho al vídeo → VideoForbiddenError, y no se firma ni se cuenta', async () => {
    const h = playbackHarness({ canPlay: false, keys: { [TENANT_A]: { [LIB]: KEY } } });
    await expect(h.service.getPlayUrl(alumno, LIB, GUID)).rejects.toBeInstanceOf(
      VideoForbiddenError,
    );
    expect(h.access.canPlay).toHaveBeenCalledWith(alumno, GUID);
    expect(h.limiter.check).not.toHaveBeenCalled();
  });

  it('con derecho al vídeo la URL sale firmada con la clave del tenant y caduca en 30 min', async () => {
    const h = playbackHarness({ keys: { [TENANT_A]: { [LIB]: KEY } } });
    const before = Date.now();
    const r = await h.service.getPlayUrl(alumno, LIB, GUID);

    expect(r.protected).toBe(true);
    expect(r.watermark).toBe(true);
    expect(r.url.startsWith(`${UNSIGNED}?token=`)).toBe(true);
    expect(bunnyWouldAccept(r.url, KEY)).toBe(true);
    // CONTROL: con otra clave en Bunny, esa misma URL se rechazaría.
    expect(bunnyWouldAccept(r.url, 'otra-clave-distinta')).toBe(false);

    const expiresMs = Date.parse(r.expiresAt!);
    expect(expiresMs).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });

  it('CADUCIDAD: la URL firmada deja de valer pasada su fecha', async () => {
    const h = playbackHarness({ keys: { [TENANT_A]: { [LIB]: KEY } } });
    const r = await h.service.getPlayUrl(alumno, LIB, GUID);
    const expiresMs = Date.parse(r.expiresAt!);
    expect(bunnyWouldAccept(r.url, KEY, expiresMs - 1000)).toBe(true);
    expect(bunnyWouldAccept(r.url, KEY, expiresMs)).toBe(false);
    // Y no se puede alargar a mano: cambiar `expires` invalida el token.
    const stretched = new URL(r.url);
    stretched.searchParams.set('expires', String(Math.floor(expiresMs / 1000) + 86_400));
    expect(bunnyWouldAccept(stretched.toString(), KEY, expiresMs - 1000)).toBe(false);
  });

  it('AISLAMIENTO: cada tenant firma con SU clave; el que no tiene, no firma', async () => {
    const h = playbackHarness({
      keys: { [TENANT_A]: { [LIB]: KEY }, [TENANT_B]: { [LIB]: 'clave-del-tenant-b' } },
    });
    const a = await h.service.getPlayUrl(alumno, LIB, GUID);
    const b = await h.service.getPlayUrl({ ...alumno, tenantId: TENANT_B }, LIB, GUID);
    expect(bunnyWouldAccept(a.url, KEY)).toBe(true);
    expect(bunnyWouldAccept(b.url, KEY)).toBe(false);
    expect(bunnyWouldAccept(b.url, 'clave-del-tenant-b')).toBe(true);

    const sinClave = playbackHarness({ keys: { [TENANT_A]: { [LIB]: KEY } } });
    const c = await sinClave.service.getPlayUrl({ ...alumno, tenantId: TENANT_B }, LIB, GUID);
    expect(c).toEqual({ url: UNSIGNED, expiresAt: null, protected: false, watermark: false });
  });

  it('la marca de agua y el tope salen de los ajustes del tenant', async () => {
    const h = playbackHarness({
      keys: { [TENANT_A]: { [LIB]: KEY } },
      settings: { [TENANT_A]: { watermark: false, maxVideosPerHour: 7, maxVideosPerDay: 21 } },
    });
    expect((await h.service.getPlayUrl(alumno, LIB, GUID)).watermark).toBe(false);
    expect(h.limiter.check).toHaveBeenCalledWith(TENANT_A, USER, GUID, { perHour: 7, perDay: 21 });
  });

  it('quien gestiona cursos no pasa por el tope', async () => {
    const h = playbackHarness({ limited: true, keys: { [TENANT_A]: { [LIB]: KEY } } });
    const r = await h.service.getPlayUrl({ ...alumno, roles: ['tenant_admin'] }, LIB, GUID);
    expect(r.protected).toBe(true);
    expect(h.limiter.check).not.toHaveBeenCalled();
  });

  it('TOPE superado → VideoRateLimitedError y UNA sola fila de auditoría por ventana', async () => {
    const h = playbackHarness({ limited: true, keys: { [TENANT_A]: { [LIB]: KEY } } });
    const first = await h.service.getPlayUrl(alumno, LIB, GUID).catch((e) => e);
    expect(first).toBeInstanceOf(VideoRateLimitedError);
    expect(first).toMatchObject({ window: 'hour', retryAfterSeconds: 120 });
    await expect(h.service.getPlayUrl(alumno, LIB, GUID)).rejects.toBeInstanceOf(
      VideoRateLimitedError,
    );

    expect(h.auditLog.record).toHaveBeenCalledTimes(1);
    expect(h.auditLog.record).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      actorId: USER,
      action: 'video.play_url.rate_limited',
      resourceType: 'user',
      resourceId: USER,
      metadata: { window: 'hour', limit: 30, guid: GUID, retryAfterSeconds: 120 },
    });
  });

  it('si la auditoría falla, el alumno recibe igualmente su 429 (no un 500)', async () => {
    const h = playbackHarness({ limited: true, keys: { [TENANT_A]: { [LIB]: KEY } } });
    h.auditLog.record.mockRejectedValue(new Error('db caída'));
    await expect(h.service.getPlayUrl(alumno, LIB, GUID)).rejects.toBeInstanceOf(
      VideoRateLimitedError,
    );
  });
});

// ──────────────────────────── controllers ────────────────────────────

const claims = (roles: string[], tenantId = TENANT_A) =>
  ({ sub: USER, tenantId, roles, mfaVerified: true }) as never;

describe('VideoController', () => {
  it('sin sesión → 401', async () => {
    const ctrl = new VideoController({ getPlayUrl: vi.fn() } as never);
    await expect(ctrl.playUrl(undefined, LIB, GUID)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('parámetros no válidos → 400 VIDEO_BAD_REQUEST, sin llegar al servicio', async () => {
    const getPlayUrl = vi.fn();
    const ctrl = new VideoController({ getPlayUrl } as never);
    for (const [lib, guid] of [
      ['abc', GUID],
      [LIB, 'no-es-un-guid'],
      [LIB, `${GUID}%`],
      ['1234567890123', GUID],
    ]) {
      const error = await ctrl.playUrl(claims(['alumno']), lib!, guid!).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: 'VIDEO_BAD_REQUEST' });
    }
    expect(getPlayUrl).not.toHaveBeenCalled();
  });

  it('traduce los errores a 403 VIDEO_FORBIDDEN y 429 VIDEO_RATE_LIMITED', async () => {
    const forbidden = new VideoController({
      getPlayUrl: vi.fn(async () => {
        throw new VideoForbiddenError();
      }),
    } as never);
    const e403 = await forbidden.playUrl(claims(['alumno']), LIB, GUID).catch((e) => e);
    expect(e403).toBeInstanceOf(HttpException);
    expect(e403.getStatus()).toBe(403);
    expect(e403.getResponse()).toMatchObject({ code: 'VIDEO_FORBIDDEN' });

    const limited = new VideoController({
      getPlayUrl: vi.fn(async () => {
        throw new VideoRateLimitedError('day', 600);
      }),
    } as never);
    const e429 = await limited.playUrl(claims(['alumno']), LIB, GUID).catch((e) => e);
    expect(e429.getStatus()).toBe(429);
    expect(e429.getResponse()).toMatchObject({
      code: 'VIDEO_RATE_LIMITED',
      window: 'day',
      retryAfterSeconds: 600,
    });
  });

  it('un error inesperado no se disfraza de 403', async () => {
    const boom = new Error('boom');
    const ctrl = new VideoController({
      getPlayUrl: vi.fn(async () => {
        throw boom;
      }),
    } as never);
    await expect(ctrl.playUrl(claims(['alumno']), LIB, GUID)).rejects.toBe(boom);
  });

  it('pasa el tenant y el usuario de la SESIÓN (no de la URL) y el GUID en minúsculas', async () => {
    const getPlayUrl = vi.fn(async () => ({
      url: 'u',
      expiresAt: null,
      protected: false,
      watermark: false,
    }));
    const ctrl = new VideoController({ getPlayUrl } as never);
    await ctrl.playUrl(claims(['alumno'], TENANT_B), LIB, GUID.toUpperCase());
    expect(getPlayUrl).toHaveBeenCalledWith(
      { tenantId: TENANT_B, userId: USER, roles: ['alumno'] },
      LIB,
      GUID,
    );
  });
});

describe('VideoProtectionAdminController', () => {
  function harness(rowsByCall: unknown[][] = []) {
    const { service, config, prisma } = makeConfigService(rowsByCall);
    const auditLog = { record: vi.fn(async () => undefined) };
    const tenantResolver = {
      resolveTenantWebBaseUrl: vi.fn(async () => 'https://aula.example.com'),
    };
    const runCheck = vi.fn(async () => ({
      outcome: 'ok' as const,
      signed: { status: 200, playable: true },
      unsigned: { status: 200, playable: false },
    }));
    const ctrl = new VideoProtectionAdminController(
      service,
      auditLog as never,
      tenantResolver as never,
      runCheck as never,
    );
    return { ctrl, service, config, prisma, auditLog, tenantResolver, runCheck };
  }
  const req = { headers: {} } as never;

  it('sin sesión → 401; alumno o formador → 403 con su code, en TODAS las rutas', async () => {
    const { ctrl, config, runCheck } = harness();
    await expect(ctrl.status(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    for (const role of ['alumno', 'formador']) {
      const user = claims([role]);
      const calls = [
        () => ctrl.status(user),
        () => ctrl.putSettings(user, { enabled: false }),
        () => ctrl.putTokenKey(user, { libraryId: LIB, tokenKey: KEY }),
        () => ctrl.check(user, { libraryId: LIB }, req),
      ];
      for (const call of calls) {
        const error = await call().catch((e) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.getResponse()).toMatchObject({ code: 'ADMIN_VIDEO_PROTECTION_FORBIDDEN' });
      }
    }
    expect(config.set).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('estado inicial: protección sin activar y ninguna librería', async () => {
    const { ctrl } = harness();
    expect(await ctrl.status(claims(['tenant_admin']))).toEqual({
      enabled: true,
      active: false,
      watermark: true,
      limits: { perHour: 30, perDay: 100 },
      libraries: [],
    });
  });

  it('el admin guarda la clave: queda activa y la clave NO vuelve ni queda en la auditoría', async () => {
    const { ctrl, config, auditLog } = harness();
    const res = await ctrl.putTokenKey(claims(['tenant_admin']), { libraryId: LIB, tokenKey: KEY });

    expect(res.active).toBe(true);
    expect(res.libraries).toEqual([
      { libraryId: LIB, configured: true, inUse: false, lastCheck: null },
    ]);
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(config.store.get(`${TENANT_A}|${VIDEO_PROTECTION_SCOPE}|${BUNNY_KEYS_SETTING}`)).toEqual(
      { isSecret: true, value: { libraries: { [LIB]: { signingSecret: KEY } } } },
    );
    expect(auditLog.record).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      actorId: USER,
      action: 'video_protection.token_key_updated',
      resourceType: 'video_library',
      resourceId: LIB,
      metadata: { libraryId: LIB },
    });
    expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain(KEY);
  });

  it('AISLAMIENTO: la clave que guarda el admin de A no aparece en el estado de B', async () => {
    const { ctrl } = harness();
    await ctrl.putTokenKey(claims(['tenant_admin'], TENANT_A), { libraryId: LIB, tokenKey: KEY });
    const b = await ctrl.status(claims(['tenant_admin'], TENANT_B));
    expect(b.active).toBe(false);
    expect(b.libraries).toEqual([]);
  });

  it('desactivar y volver a activar conserva la clave', async () => {
    const { ctrl, service, auditLog } = harness();
    const admin = claims(['tenant_admin']);
    await ctrl.putTokenKey(admin, { libraryId: LIB, tokenKey: KEY });

    const off = await ctrl.putSettings(admin, { enabled: false });
    expect(off).toMatchObject({ enabled: false, active: false });
    expect(off.libraries[0]).toMatchObject({ libraryId: LIB, configured: true });
    expect((await service.resolveLibrary(TENANT_A, LIB)).active).toBe(false);

    const on = await ctrl.putSettings(admin, { enabled: true });
    expect(on).toMatchObject({ enabled: true, active: true });
    expect((await service.resolveLibrary(TENANT_A, LIB)).active).toBe(true);
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'video_protection.settings_updated' }),
    );
  });

  it('ajusta el tope y la marca de agua sin tocar lo que no se manda', async () => {
    const { ctrl } = harness();
    const admin = claims(['super_admin']);
    await ctrl.putSettings(admin, { maxVideosPerHour: 10, maxVideosPerDay: 40 });
    const res = await ctrl.putSettings(admin, { watermark: false });
    expect(res).toMatchObject({
      enabled: true,
      watermark: false,
      limits: { perHour: 10, perDay: 40 },
    });
  });

  it('un tope diario menor que el horario → 400 con su code, y no se guarda', async () => {
    const { ctrl, config } = harness();
    const admin = claims(['tenant_admin']);
    for (const dto of [{ maxVideosPerHour: 50, maxVideosPerDay: 10 }, { maxVideosPerDay: 5 }]) {
      const error = await ctrl.putSettings(admin, dto).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: 'ADMIN_VIDEO_PROTECTION_LIMITS_INVALID' });
    }
    expect(config.set).not.toHaveBeenCalled();
  });

  it('comprobar sin clave guardada → no_key, sin llamar a Bunny', async () => {
    const { ctrl, runCheck } = harness();
    const res = await ctrl.check(claims(['tenant_admin']), { libraryId: LIB }, req);
    expect(res).toMatchObject({ libraryId: LIB, outcome: 'no_key', signedStatus: null });
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('comprobar sin ningún vídeo de esa librería → no_video, sin llamar a Bunny', async () => {
    const { ctrl, runCheck } = harness([[]]);
    const admin = claims(['tenant_admin']);
    await ctrl.putTokenKey(admin, { libraryId: LIB, tokenKey: KEY });
    const res = await ctrl.check(admin, { libraryId: LIB }, req);
    expect(res.outcome).toBe('no_video');
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('comprueba con un vídeo del tenant, su clave y el dominio del aula, y guarda el resultado', async () => {
    // Consultas crudas, en orden: librerías en uso (el estado que devuelve el
    // PUT), el vídeo de muestra, y librerías en uso otra vez (el GET final).
    const { ctrl, runCheck, tenantResolver } = harness([[], [{ guid: GUID }], [{ lib: LIB }]]);
    const admin = claims(['tenant_admin']);
    await ctrl.putTokenKey(admin, { libraryId: LIB, tokenKey: KEY });

    const res = await ctrl.check(admin, { libraryId: LIB }, req);
    expect(res).toMatchObject({
      libraryId: LIB,
      outcome: 'ok',
      signedStatus: 200,
      unsignedStatus: 200,
    });
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(tenantResolver.resolveTenantWebBaseUrl).toHaveBeenCalledWith(TENANT_A, req);
    expect(runCheck).toHaveBeenCalledWith({
      libraryId: LIB,
      guid: GUID,
      tokenKey: KEY,
      referer: 'https://aula.example.com/',
    });

    const status = await ctrl.status(admin);
    expect(status.libraries).toEqual([
      {
        libraryId: LIB,
        configured: true,
        inUse: true,
        lastCheck: { outcome: 'ok', checkedAt: res.checkedAt },
      },
    ]);
  });
});

// ─────────────────── comprobación real contra Bunny ───────────────────

/**
 * Bunny de mentira que hace lo que hace el de verdad con un embed: si la
 * librería exige token, recalcula el hash con SU clave y solo entonces sirve
 * el reproductor; si no, una página de error. `errorAs200` reproduce lo que
 * hace en producción —la página «403» llega con HTTP 200—; sin él, contesta
 * con el código de error, por si cambia.
 */
function fakeBunny(cfg: {
  libraryKey: string;
  enforced: boolean;
  errorAs200?: boolean;
  missingVideo?: boolean;
}) {
  const seen: Array<{ url: string; referer: string | null }> = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ url: url.toString(), referer: headers.get('referer') });
    if (cfg.missingVideo) return new Response('<h1>404</h1>', { status: 404 });

    const guid = url.pathname.split('/').pop() ?? '';
    const player = `<html><video><source src="https://vz-test.b-cdn.net/${guid}/playlist.m3u8"></video></html>`;
    if (!cfg.enforced) return new Response(player, { status: 200 });

    const token = url.searchParams.get('token');
    const expires = url.searchParams.get('expires');
    const expected = createHash('sha256')
      .update(`${cfg.libraryKey}${guid}${expires}`)
      .digest('hex');
    const valid =
      Boolean(token && expires && Number(expires) * 1000 > Date.now()) && token === expected;
    if (valid) return new Response(player, { status: 200 });
    return new Response('<html><h1>403</h1><p>Unauthorized</p></html>', {
      status: cfg.errorAs200 ? 200 : 403,
    });
  };
  return { fetchImpl: impl as unknown as typeof fetch, seen };
}

describe('looksLikeBunnyPlayer', () => {
  it('el reproductor trae la lista de reproducción del vídeo; la página de error, no', () => {
    expect(looksLikeBunnyPlayer(200, '<source src="https://x.b-cdn.net/g/playlist.m3u8">')).toBe(
      true,
    );
    expect(looksLikeBunnyPlayer(200, '<html><h1>403</h1></html>')).toBe(false);
  });

  it('un código de error nunca es el reproductor, traiga lo que traiga', () => {
    expect(looksLikeBunnyPlayer(403, 'playlist.m3u8')).toBe(false);
    expect(looksLikeBunnyPlayer(500, 'playlist.m3u8')).toBe(false);
  });
});

describe('checkBunnySignature', () => {
  const base = { libraryId: LIB, guid: GUID, referer: 'https://aula.example.com/' };

  it.each([[true], [false]])(
    'ok: Bunny exige token y acepta la clave guardada (error servido con 200: %s)',
    async (errorAs200) => {
      const bunny = fakeBunny({ libraryKey: KEY, enforced: true, errorAs200 });
      const r = await checkBunnySignature({ ...base, tokenKey: KEY, fetchImpl: bunny.fetchImpl });
      expect(r.outcome).toBe('ok');
      expect(r.signed.playable).toBe(true);
      expect(r.unsigned.playable).toBe(false);
    },
  );

  it.each([[true], [false]])(
    'rejected: Bunny exige token y la clave guardada NO es la suya (error con 200: %s)',
    async (errorAs200) => {
      const bunny = fakeBunny({ libraryKey: 'la-clave-real-de-bunny', enforced: true, errorAs200 });
      const r = await checkBunnySignature({ ...base, tokenKey: KEY, fetchImpl: bunny.fetchImpl });
      expect(r.outcome).toBe('rejected');
      expect(r.signed.playable).toBe(false);
    },
  );

  it('not_enforced: Bunny aún no exige token — carga todo y la clave NO queda validada', async () => {
    // Clave equivocada a propósito: mientras Bunny no exija token, carga igual.
    // Por eso un «la firmada carga» a secas no demuestra nada.
    const bunny = fakeBunny({ libraryKey: 'la-clave-real-de-bunny', enforced: false });
    const r = await checkBunnySignature({ ...base, tokenKey: KEY, fetchImpl: bunny.fetchImpl });
    expect(r.outcome).toBe('not_enforced');
    expect(r.signed.playable).toBe(true);
    expect(r.unsigned.playable).toBe(true);
  });

  it('video_unavailable: Bunny dice que ese vídeo no existe', async () => {
    const bunny = fakeBunny({ libraryKey: KEY, enforced: true, missingVideo: true });
    const r = await checkBunnySignature({ ...base, tokenKey: KEY, fetchImpl: bunny.fetchImpl });
    expect(r.outcome).toBe('video_unavailable');
    expect(r.signed.status).toBe(404);
  });

  it('unreachable: sin red, o Bunny con un 5xx', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect((await checkBunnySignature({ ...base, tokenKey: KEY, fetchImpl: down })).outcome).toBe(
      'unreachable',
    );
    const broken = (async () =>
      new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    expect((await checkBunnySignature({ ...base, tokenKey: KEY, fetchImpl: broken })).outcome).toBe(
      'unreachable',
    );
  });

  it('si el control (sin firma) no contesta, no se da por buena: unreachable', async () => {
    const bunny = fakeBunny({ libraryKey: KEY, enforced: true });
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).includes('token=')) throw new TypeError('fetch failed');
      return bunny.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    const r = await checkBunnySignature({ ...base, tokenKey: KEY, fetchImpl: flaky });
    expect(r.outcome).toBe('unreachable');
    expect(r.signed.playable).toBe(true);
  });

  it('pide las dos URL al host de Bunny, con el dominio del aula como Referer', async () => {
    const bunny = fakeBunny({ libraryKey: KEY, enforced: true });
    await checkBunnySignature({ ...base, tokenKey: KEY, fetchImpl: bunny.fetchImpl });
    expect(bunny.seen).toHaveLength(2);
    for (const call of bunny.seen) {
      expect(call.url.startsWith(`https://iframe.mediadelivery.net/embed/${LIB}/${GUID}`)).toBe(
        true,
      );
      expect(call.referer).toBe('https://aula.example.com/');
    }
    expect(bunny.seen.filter((c) => c.url.includes('token=')).length).toBe(1);
  });

  describe('por HTTP de verdad (servidor local que hace de Bunny)', () => {
    let server: Server;
    let origin: string;
    const requests: Array<{
      path: string;
      referer: string | undefined;
      userAgent: string | undefined;
    }> = [];

    beforeAll(async () => {
      server = createServer((req, res) => {
        requests.push({
          path: req.url ?? '',
          referer: req.headers['referer'],
          userAgent: req.headers['user-agent'],
        });
        const url = new URL(req.url ?? '/', 'http://local');
        if (url.pathname.includes('/lento/')) return; // nunca contesta: fuerza el timeout
        const guid = url.pathname.split('/').pop() ?? '';
        const token = url.searchParams.get('token');
        const expires = url.searchParams.get('expires');
        const expected = createHash('sha256').update(`${KEY}${guid}${expires}`).digest('hex');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          token === expected
            ? `<video><source src="https://vz-test.b-cdn.net/${guid}/playlist.m3u8"></video>`
            : '<h1>403</h1>',
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    beforeEach(() => {
      requests.length = 0;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /** `fetch` real, redirigido del host de Bunny al servidor local. */
    const viaLocal = (prefix = '') =>
      ((input: string | URL | Request, init?: RequestInit) =>
        fetch(
          String(input).replace('https://iframe.mediadelivery.net', `${origin}${prefix}`),
          init,
        )) as unknown as typeof fetch;

    it('la firma viaja bien por la red y el Referer llega', async () => {
      const r = await checkBunnySignature({ ...base, tokenKey: KEY, fetchImpl: viaLocal() });
      expect(r.outcome).toBe('ok');
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.referer).toBe('https://aula.example.com/');
        expect(request.userAgent).toBe('Didacta-Video-Protection-Check');
      }
    });

    it('CONTROL: la misma petición con otra clave guardada → rejected', async () => {
      const r = await checkBunnySignature({
        ...base,
        tokenKey: 'otra-clave-distinta',
        fetchImpl: viaLocal(),
      });
      expect(r.outcome).toBe('rejected');
    });

    it('si Bunny no contesta a tiempo, corta y dice unreachable', async () => {
      const r = await checkBunnySignature({
        ...base,
        tokenKey: KEY,
        fetchImpl: viaLocal('/lento'),
        timeoutMs: 150,
      });
      expect(r.outcome).toBe('unreachable');
      expect(r.signed.status).toBeNull();
    });
  });
});
