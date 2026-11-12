/**
 * Subida de vídeo a Bunny Stream (Didacta Cloud) contra un Postgres REAL,
 * conectando como el runtime post-flip: rol `didacta_app` (NOSUPERUSER,
 * NOBYPASSRLS) y RLS forzada. Bunny, Google Drive, el correo y el archivado
 * son dobles en memoria; la base de datos y las consultas crudas, no.
 *
 * Cubre: colección por aula, firma TUS, cuotas antes y después de vender,
 * estado leído de Bunny (webhook), recorte a 720p, rechazos tras codificar,
 * reproducción firmada y aislada por aula, horas vistas, limpieza de lo que
 * nadie usa y la política de inactividad completa (avisos, en seco, copia,
 * borrado, archivado, caducidad de las copias y supresión).
 *
 * REQUISITOS: Postgres con el schema aplicado y `DATABASE_URL` de un rol
 * ADMIN (igual que `video-protection-rls.integration.test.ts`). SKIP sin
 * `DATABASE_URL`.
 */

import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { PrismaTenantConfigService } from '../../src/modules/prisma-tenant-config.service';
import { SecretCipherService } from '../../src/modules/secret-cipher.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import type { GoogleDriveClient } from '../../src/video/cloud/google-drive.client';
import type { VideoCloudEnabled } from '../../src/video/cloud/video-cloud.config';
import { VideoCloudError, VideoCloudService } from '../../src/video/cloud/video-cloud.service';
import { VideoInactivityService } from '../../src/video/cloud/video-inactivity.service';
import { VideoAccessService } from '../../src/video/video-access.service';
import { VideoPlayLimiter } from '../../src/video/video-play-limiter';
import {
  VideoForbiddenError,
  VideoPlaybackService,
  VideoWatchQuotaError,
} from '../../src/video/video-playback.service';
import { VideoProtectionConfigService } from '../../src/video/video-protection-config.service';
import { BunnyStreamDouble } from '../helpers/bunny-stream-double';

const ADMIN_DATABASE_URL = process.env['DATABASE_URL'];
const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

const PG_CONTAINER = process.env['RLS_TEST_PG_CONTAINER'] ?? 'didacta-postgres-test';
const PG_USER = process.env['RLS_TEST_PG_USER'] ?? 'didacta_test';
const PG_DB = process.env['RLS_TEST_PG_DB'] ?? 'didacta_test';
const APP_PASSWORD = process.env['RLS_TEST_APP_PASSWORD'] ?? 'rls_test_didacta_app_pw';
const REPO_ROOT = resolve(__dirname, '../../../..');

const H = 3600;
const DAY = 24 * H * 1000;
const LIB = '700900';

function applySqlFileViaPsql(relPath: string): void {
  const sql = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'psql',
      '-U',
      PG_USER,
      '-d',
      PG_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    { input: sql, stdio: ['pipe', 'pipe', 'inherit'] },
  );
}

function buildDidactaAppUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = 'didacta_app';
  url.password = APP_PASSWORD;
  return url.toString();
}

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const CONFIG: VideoCloudEnabled = {
  enabled: true,
  apiKey: 'api-key-de-prueba',
  libraryId: LIB,
  cdnHostname: 'vz-prueba.b-cdn.net',
  tokenKey: 'clave-de-firma-de-prueba',
  webhookSecret: 'solo-lectura-de-prueba',
  apiBaseUrl: 'https://video.bunnycdn.com',
  tusEndpoint: 'https://video.bunnycdn.com/tusupload',
  drive: {
    folderId: 'carpeta-de-prueba',
    serviceAccount: {
      clientEmail: 'copias@prueba.iam.gserviceaccount.com',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      tokenUri: 'https://oauth2.googleapis.com/token',
    },
  },
  operatorAlertEmail: null,
};

class DriveDouble implements GoogleDriveClient {
  readonly files = new Map<string, { name: string; bytes: number; app: Record<string, string> }>();
  failUpload: Error | null = null;
  readonly deleted: string[] = [];
  async upload(input: Parameters<GoogleDriveClient['upload']>[0]) {
    if (this.failUpload) throw this.failUpload;
    let bytes = 0;
    for await (const c of input.chunks) bytes += c.byteLength;
    const fileId = `drive-${randomUUID()}`;
    this.files.set(fileId, { name: input.name, bytes, app: input.appProperties });
    return { fileId, bytes };
  }
  async deleteFile(fileId: string) {
    this.deleted.push(fileId);
    return this.files.delete(fileId) ? ('deleted' as const) : ('not_found' as const);
  }
}

describeWithDb('Vídeo subido a Bunny — Postgres real como didacta_app (RLS forzada)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let bunny: BunnyStreamDouble;
  let cloud: VideoCloudService;
  let audit: PrismaAuditLogService;
  let clock: Date;
  const realNow = Date.now();
  const at = (ms: number) => {
    clock = new Date(realNow + ms);
  };
  const tenants: string[] = [];

  async function seedTenant(label: string) {
    const id = randomUUID();
    const slug = `vid-${label}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    await admin.tenant.create({ data: { id, slug, name: `Academia ${label}` } });
    tenants.push(id);
    const courseId = randomUUID();
    const moduleId = randomUUID();
    await admin.modCoursesCourse.create({
      data: {
        id: courseId,
        tenantId: id,
        slug: `c-${courseId.slice(0, 8)}`,
        title: 'Curso',
        status: 'PUBLISHED',
      },
    });
    await admin.modCoursesModule.create({
      data: { id: moduleId, tenantId: id, courseId, title: 'Módulo', position: 0 },
    });
    const lessons: string[] = [];
    for (const [position, type] of (['VIDEO', 'VIDEO', 'TEXT'] as const).entries()) {
      const lessonId = randomUUID();
      lessons.push(lessonId);
      await admin.modCoursesLesson.create({
        data: {
          id: lessonId,
          tenantId: id,
          moduleId,
          type,
          title: `L${position}`,
          position,
          content: {},
        },
      });
    }
    return { id, slug, courseId, lessons };
  }

  async function setLessonVideo(tenantId: string, lessonId: string, url: string | null) {
    await admin.modCoursesLesson.update({
      where: { id: lessonId },
      data: { content: url ? { videoUrl: url } : {} },
    });
    void tenantId;
  }

  async function addSale(
    tenantId: string,
    platformFee: number,
    opts: { refundedAll?: boolean } = {},
  ) {
    const account = await admin.modPayoutsAccount.create({
      data: { tenantId, country: 'ES', entityType: 'individual', status: 'READY' },
    });
    await admin.modPayoutsSale.create({
      data: {
        tenantId,
        accountId: account.id,
        sourceKind: 'ORDER',
        sourceRef: randomUUID(),
        stripeChargeId: `ch_${randomBytes(8).toString('hex')}`,
        presentmentAmount: platformFee * 20,
        presentmentCurrency: 'eur',
        gross: platformFee * 20,
        platformFee,
        currency: 'eur',
        refundedAmount: opts.refundedAll ? platformFee * 20 : 0,
        chargedAt: new Date(realNow - DAY),
      },
    });
  }

  async function upload(
    tenantId: string,
    lessonId: string,
    over: Partial<{
      durationSeconds: number;
      sizeBytes: number;
      fileName: string;
      mimeType: string;
    }> = {},
  ) {
    return cloud.createUpload({
      tenantId,
      userId: randomUUID(),
      lessonId,
      fileName: 'Clase 1.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 200 * 1024 ** 2,
      durationSeconds: 20 * 60,
      ...over,
    });
  }

  async function asset(tenantId: string, id: string) {
    return runAsTenant(tenantId, () => prisma.videoAsset.findFirstOrThrow({ where: { id } }));
  }

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_DATABASE_URL } } });
    await admin.$connect();
    applySqlFileViaPsql('packages/database/prisma/rls.sql');
    applySqlFileViaPsql('packages/database/prisma/grants.sql');
    await admin.$executeRawUnsafe(
      `ALTER ROLE didacta_app PASSWORD '${APP_PASSWORD.replace(/'/g, "''")}'`,
    );

    const previousUrl = process.env['DATABASE_URL'];
    const previousMode = process.env['RLS_ENFORCEMENT'];
    process.env['DATABASE_URL'] = buildDidactaAppUrl(ADMIN_DATABASE_URL!);
    process.env['RLS_ENFORCEMENT'] = 'on';
    try {
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      closeModule = () => moduleRef.close();
    } finally {
      process.env['DATABASE_URL'] = previousUrl;
      if (previousMode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previousMode;
    }
    audit = new PrismaAuditLogService(prisma);
  }, 120_000);

  beforeEach(() => {
    at(0);
    bunny = new BunnyStreamDouble(LIB);
    cloud = new VideoCloudService(CONFIG, prisma, bunny, audit, { now: () => clock });
  });

  afterAll(async () => {
    await closeModule?.();
    await admin?.$disconnect();
  });

  // ─────────────────────────── subida ───────────────────────────

  describe('subida', () => {
    it('crea la colección DC_<slug> UNA vez y devuelve la firma TUS del vídeo', async () => {
      const t = await seedTenant('a');
      const first = await upload(t.id, t.lessons[0]!);
      const second = await upload(t.id, t.lessons[1]!);
      expect(bunny.calls.filter((c) => c.startsWith('createCollection:'))).toEqual([
        `createCollection:DC_${t.slug}`,
      ]);
      const state = await runAsTenant(t.id, () =>
        prisma.videoTenantState.findUniqueOrThrow({ where: { tenantId: t.id } }),
      );
      expect(state.collectionName).toBe(`DC_${t.slug}`);
      expect(first.upload.metadata.collection).toBe(state.collectionId);
      expect(second.upload.metadata.collection).toBe(state.collectionId);

      const { headers } = first.upload;
      const guid = headers.VideoId;
      expect(headers.LibraryId).toBe(LIB);
      expect(headers.AuthorizationSignature).toBe(
        createHash('sha256')
          .update(`${LIB}${CONFIG.apiKey}${headers.AuthorizationExpire}${guid}`)
          .digest('hex'),
      );
      expect(Number(headers.AuthorizationExpire) - Math.floor(clock.getTime() / 1000)).toBe(
        24 * 3600,
      );
      expect(first.upload.endpoint).toBe('https://video.bunnycdn.com/tusupload');
      // Nada en la respuesta lleva la API key.
      expect(JSON.stringify(first)).not.toContain(CONFIG.apiKey);
      expect(first.asset).toMatchObject({
        status: 'UPLOADING',
        maxResolution: '720p',
        embedUrl: `https://iframe.mediadelivery.net/embed/${LIB}/${guid}`,
        title: 'Clase 1',
      });
    });

    it('reutiliza una colección que ya existía en Bunny con ese nombre', async () => {
      const t = await seedTenant('reuse');
      const existing = await bunny.createCollection(`DC_${t.slug}`);
      bunny.calls.length = 0;
      const res = await upload(t.id, t.lessons[0]!);
      expect(res.upload.metadata.collection).toBe(existing.guid);
      expect(bunny.calls.some((c) => c.startsWith('createCollection'))).toBe(false);
    });

    it('rechaza ANTES de firmar: lección de otra aula, lección no de vídeo, fichero grande o largo', async () => {
      const a = await seedTenant('rej-a');
      const b = await seedTenant('rej-b');
      const code = async (p: Promise<unknown>) => {
        try {
          await p;
          return 'ok';
        } catch (err) {
          return err instanceof VideoCloudError ? `${err.status}:${err.code}` : String(err);
        }
      };
      // La lección de B no existe para A (RLS + filtro por tenant).
      expect(await code(upload(a.id, b.lessons[0]!))).toBe('404:VIDEO_UPLOAD_LESSON_NOT_FOUND');
      expect(await code(upload(a.id, a.lessons[2]!))).toBe('400:VIDEO_UPLOAD_LESSON_NOT_VIDEO');
      expect(await code(upload(a.id, a.lessons[0]!, { sizeBytes: 4 * 1024 ** 3 + 1 }))).toBe(
        '400:VIDEO_FILE_TOO_BIG',
      );
      expect(await code(upload(a.id, a.lessons[0]!, { durationSeconds: 2 * H + 1 }))).toBe(
        '400:VIDEO_FILE_TOO_LONG',
      );
      expect(
        await code(upload(a.id, a.lessons[0]!, { mimeType: 'application/pdf', fileName: 'x.pdf' })),
      ).toBe('400:VIDEO_NOT_A_VIDEO');
      // Nada de eso llegó a Bunny.
      expect(bunny.calls.filter((c) => c.startsWith('createVideo'))).toEqual([]);
    });

    it('cuota antes de vender: 4 h 20 min usadas + 41 min → 409 con los números; tras vender, cabe', async () => {
      const t = await seedTenant('quota');
      await upload(t.id, t.lessons[0]!, { durationSeconds: 2 * H });
      await upload(t.id, t.lessons[0]!, { durationSeconds: 2 * H });
      await upload(t.id, t.lessons[1]!, { durationSeconds: 20 * 60 });
      let error: VideoCloudError | null = null;
      try {
        await upload(t.id, t.lessons[1]!, { durationSeconds: 41 * 60 });
      } catch (err) {
        error = err as VideoCloudError;
      }
      expect(error?.code).toBe('VIDEO_STORAGE_QUOTA');
      expect(error?.status).toBe(409);
      expect(error?.details).toEqual({
        usedSeconds: 4 * H + 20 * 60,
        limitSeconds: 5 * H,
        tier: 'pre_sale',
        postSaleStoredSeconds: 50 * H,
      });
      const view = await cloud.quotaView(t.id);
      expect(view).toMatchObject({
        tier: 'pre_sale',
        maxResolution: '720p',
        stored: { usedSeconds: 4 * H + 20 * 60, limitSeconds: 5 * H },
        watched: { usedSeconds: 0, limitSeconds: 100 * H },
      });

      // Una venta devuelta entera NO cuenta; una de verdad, sí.
      await addSale(t.id, 500, { refundedAll: true });
      expect((await cloud.quotaView(t.id)).tier).toBe('pre_sale');
      await addSale(t.id, 6000);
      const after = await cloud.quotaView(t.id);
      expect(after).toMatchObject({
        tier: 'post_sale',
        maxResolution: '1080p',
        stored: { limitSeconds: 70 * H, bonusSeconds: 20 * H },
        watched: { limitSeconds: null },
      });
      const ok = await upload(t.id, t.lessons[1]!, { durationSeconds: 41 * 60 });
      expect(ok.asset.maxResolution).toBe('1080p');
    });

    it('si Bunny falla al crear el vídeo: 502 y ninguna fila', async () => {
      const t = await seedTenant('bunny-down');
      await upload(t.id, t.lessons[0]!); // crea la colección
      bunny.failNext.createVideo = new Error('Bunny caído');
      await expect(upload(t.id, t.lessons[1]!)).rejects.toMatchObject({
        status: 502,
        code: 'VIDEO_UPLOAD_PROVIDER_ERROR',
      });
      const rows = await runAsTenant(t.id, () =>
        prisma.videoAsset.count({ where: { tenantId: t.id } }),
      );
      expect(rows).toBe(1);
    });

    it('reanudar: firma nueva mientras sube; terminada, 409', async () => {
      const t = await seedTenant('resign');
      const { asset: a } = await upload(t.id, t.lessons[0]!);
      at(3 * H * 1000);
      const ticket = await cloud.resign(t.id, a.id);
      expect(Number(ticket.headers.AuthorizationExpire)).toBe(
        Math.floor(clock.getTime() / 1000) + 24 * 3600,
      );
      bunny.finish(ticket.headers.VideoId, { lengthSeconds: 600 });
      await cloud.handleWebhook({ libraryId: Number(LIB), guid: ticket.headers.VideoId });
      await expect(cloud.resign(t.id, a.id)).rejects.toMatchObject({
        code: 'VIDEO_UPLOAD_NOT_RESUMABLE',
      });
    });
  });

  // ─────────────────────────── estado desde Bunny ───────────────────────────

  describe('estado (webhook)', () => {
    it('listo: guarda la duración real y, antes de vender, quita 1080p', async () => {
      const t = await seedTenant('ready');
      const { asset: a, upload: u } = await upload(t.id, t.lessons[0]!);
      const guid = u.headers.VideoId;
      bunny.processing(guid);
      expect(await cloud.handleWebhook({ libraryId: Number(LIB), guid })).toBe('applied');
      expect((await asset(t.id, a.id)).status).toBe('PROCESSING');

      bunny.finish(guid, { lengthSeconds: 1234, storageBytes: 98_765 });
      // Un aviso repetido no estropea nada (se lee de Bunny cada vez).
      await cloud.handleWebhook({ libraryId: Number(LIB), guid: guid.toUpperCase() });
      await cloud.handleWebhook({ libraryId: Number(LIB), guid });
      const row = await asset(t.id, a.id);
      expect(row).toMatchObject({
        status: 'READY',
        durationSeconds: 1234,
        storageBytes: 98_765n,
        resolutionsCapped: true,
        availableResolutions: '240p,360p,480p,720p',
      });
      expect(bunny.calls.filter((c) => c.startsWith('deleteResolutions'))).toEqual([
        `deleteResolutions:${guid}:1080p`,
      ]);
      const view = await cloud.getAsset(t.id, a.id);
      expect(view.thumbnailUrl).toMatch(
        new RegExp(
          `^https://vz-prueba\\.b-cdn\\.net/${guid}/thumbnail\\.jpg\\?token=HS256-.+&expires=\\d+$`,
        ),
      );
    });

    it('si el aula vendió mientras se codificaba, conserva 1080p', async () => {
      const t = await seedTenant('sold-midway');
      const { asset: a, upload: u } = await upload(t.id, t.lessons[0]!);
      expect(a.maxResolution).toBe('720p');
      await addSale(t.id, 500);
      bunny.finish(u.headers.VideoId, { lengthSeconds: 600 });
      // La caché de la cuota dura un minuto: se avanza el reloj.
      at(2 * 60_000);
      await cloud.handleWebhook({ libraryId: Number(LIB), guid: u.headers.VideoId });
      expect((await asset(t.id, a.id)).availableResolutions).toContain('1080p');
      expect(bunny.calls.some((c) => c.startsWith('deleteResolutions'))).toBe(false);
    });

    it('dijo 10 min y dura 3 h: se rechaza y se borra en Bunny', async () => {
      const t = await seedTenant('liar');
      await addSale(t.id, 500);
      const { asset: a, upload: u } = await upload(t.id, t.lessons[0]!, { durationSeconds: 600 });
      bunny.finish(u.headers.VideoId, { lengthSeconds: 3 * H });
      await cloud.handleWebhook({ libraryId: Number(LIB), guid: u.headers.VideoId });
      expect(await asset(t.id, a.id)).toMatchObject({
        status: 'FAILED',
        failureReason: 'too_long',
        deleteReason: 'too_long',
      });
      expect(bunny.videos.has(u.headers.VideoId)).toBe(false);
    });

    it('la duración real se pasa de la cuota: rechazado por cuota', async () => {
      const t = await seedTenant('over');
      for (const lesson of [t.lessons[0]!, t.lessons[1]!]) {
        const v = await upload(t.id, lesson, { durationSeconds: 2 * H });
        bunny.finish(v.upload.headers.VideoId, { lengthSeconds: 2 * H });
        await cloud.handleWebhook({ libraryId: Number(LIB), guid: v.upload.headers.VideoId });
        expect((await asset(t.id, v.asset.id)).status).toBe('READY');
      }
      // Dice 30 min (4 h + 30 min caben en 5 h) y dura 2 h (6 h no caben).
      const third = await upload(t.id, t.lessons[1]!, { durationSeconds: 30 * 60 });
      bunny.finish(third.upload.headers.VideoId, { lengthSeconds: 2 * H });
      await cloud.handleWebhook({ libraryId: Number(LIB), guid: third.upload.headers.VideoId });
      expect(await asset(t.id, third.asset.id)).toMatchObject({
        status: 'FAILED',
        failureReason: 'quota',
      });
      expect(bunny.videos.has(third.upload.headers.VideoId)).toBe(false);
    });

    it('codificación fallida: FAILED y fuera de Bunny', async () => {
      const t = await seedTenant('enc-fail');
      const { asset: a, upload: u } = await upload(t.id, t.lessons[0]!);
      bunny.fail(u.headers.VideoId);
      await cloud.handleWebhook({ libraryId: Number(LIB), guid: u.headers.VideoId });
      expect(await asset(t.id, a.id)).toMatchObject({
        status: 'FAILED',
        failureReason: 'encoding_failed',
      });
      expect(bunny.videos.has(u.headers.VideoId)).toBe(false);
    });

    it('otra biblioteca o un GUID desconocido: se ignora', async () => {
      expect(await cloud.handleWebhook({ libraryId: 1, guid: randomUUID() })).toBe('ignored');
      expect(await cloud.handleWebhook({ libraryId: Number(LIB), guid: randomUUID() })).toBe(
        'ignored',
      );
      expect(await cloud.handleWebhook({ libraryId: Number(LIB), guid: 'no-es-un-guid' })).toBe(
        'ignored',
      );
    });
  });

  // ─────────────────────────── reproducción ───────────────────────────

  describe('reproducción', () => {
    function playback() {
      const learning = {
        hasActiveEnrollment: async () => true,
        getCourseAvailability: async () => ({ drip: false, lessons: {} }),
      };
      const access = new VideoAccessService(prisma, {
        getLearningService: () => learning,
      } as never);
      const tenantConfig = new PrismaTenantConfigService(
        prisma,
        new SecretCipherService(randomBytes(32).toString('hex')),
        audit,
      );
      const protection = new VideoProtectionConfigService(tenantConfig, prisma, cloud);
      return {
        service: new VideoPlaybackService(
          access,
          protection,
          new VideoPlayLimiter(null),
          audit,
          cloud,
        ),
        protection,
      };
    }

    it('firma con la clave de Cloud el vídeo del aula; a otra aula que pega su URL, 403', async () => {
      const a = await seedTenant('play-a');
      const b = await seedTenant('play-b');
      const { asset: va, upload: u } = await upload(a.id, a.lessons[0]!);
      const guid = u.headers.VideoId;
      bunny.finish(guid, { lengthSeconds: 600 });
      await cloud.handleWebhook({ libraryId: Number(LIB), guid });
      await setLessonVideo(a.id, a.lessons[0]!, va.embedUrl);
      // B pega en SU lección la URL del vídeo de A.
      await setLessonVideo(b.id, b.lessons[0]!, va.embedUrl);

      const { service, protection } = playback();
      const student = (tenantId: string) => ({ tenantId, userId: randomUUID(), roles: ['alumno'] });
      const res = await runAsTenant(a.id, () => service.getPlayUrl(student(a.id), LIB, guid));
      expect(res.protected).toBe(true);
      const expires = Number(new URL(res.url).searchParams.get('expires'));
      expect(new URL(res.url).searchParams.get('token')).toBe(
        createHash('sha256').update(`${CONFIG.tokenKey}${guid}${expires}`).digest('hex'),
      );
      await expect(
        runAsTenant(b.id, () => service.getPlayUrl(student(b.id), LIB, guid)),
      ).rejects.toBeInstanceOf(VideoForbiddenError);

      // La biblioteca de Cloud no sale en el panel de protección del aula.
      const status = await runAsTenant(a.id, () => protection.status(a.id));
      expect(status.libraries.map((l) => l.libraryId)).not.toContain(LIB);
    });

    it('tope de 100 h vistas al mes antes de vender: el alumno no, el creador sí', async () => {
      const t = await seedTenant('play-quota');
      const { asset: va, upload: u } = await upload(t.id, t.lessons[0]!);
      const guid = u.headers.VideoId;
      bunny.finish(guid, { lengthSeconds: 600 });
      await cloud.handleWebhook({ libraryId: Number(LIB), guid });
      await setLessonVideo(t.id, t.lessons[0]!, va.embedUrl);
      await admin.videoUsageMonth.create({
        data: {
          tenantId: t.id,
          month: clock.toISOString().slice(0, 7),
          watchedSeconds: BigInt(100 * H),
        },
      });
      at(2 * 60_000);
      const { service } = playback();
      await expect(
        runAsTenant(t.id, () =>
          service.getPlayUrl(
            { tenantId: t.id, userId: randomUUID(), roles: ['alumno'] },
            LIB,
            guid,
          ),
        ),
      ).rejects.toBeInstanceOf(VideoWatchQuotaError);
      const editor = await runAsTenant(t.id, () =>
        service.getPlayUrl(
          { tenantId: t.id, userId: randomUUID(), roles: ['formador'] },
          LIB,
          guid,
        ),
      );
      expect(editor.protected).toBe(true);
    });
  });

  // ─────────────────────────── barrido horario ───────────────────────────

  describe('barrido horario', () => {
    it('suma al mes lo que crece el tiempo visto (y solo una vez)', async () => {
      const t = await seedTenant('watch');
      const { upload: u, asset: va } = await upload(t.id, t.lessons[0]!);
      const guid = u.headers.VideoId;
      bunny.finish(guid, { lengthSeconds: 600 });
      await setLessonVideo(t.id, t.lessons[0]!, va.embedUrl);
      bunny.watched(guid, 5000);
      expect((await cloud.reconcileTenant(t.id)).watchedAddedSeconds).toBe(5000);
      expect((await cloud.reconcileTenant(t.id)).watchedAddedSeconds).toBe(0);
      bunny.watched(guid, 5600);
      expect((await cloud.reconcileTenant(t.id)).watchedAddedSeconds).toBe(600);
      const view = await cloud.quotaView(t.id);
      expect(view.watched.usedSeconds).toBe(5600);
      expect(await cloud.tenantsWithVideo()).toContain(t.id);
    });

    it('sustituido o quitado de la lección: fuera de Bunny pasado el margen (y no antes)', async () => {
      const t = await seedTenant('cleanup');
      const old = await upload(t.id, t.lessons[0]!);
      bunny.finish(old.upload.headers.VideoId, { lengthSeconds: 600 });
      const removed = await upload(t.id, t.lessons[1]!);
      bunny.finish(removed.upload.headers.VideoId, { lengthSeconds: 600 });
      await setLessonVideo(t.id, t.lessons[0]!, old.asset.embedUrl);
      await setLessonVideo(t.id, t.lessons[1]!, removed.asset.embedUrl);
      await cloud.reconcileTenant(t.id);

      // El creador sube otro vídeo a la lección 0 (lo guarda) y quita el de la 1.
      const fresh = await upload(t.id, t.lessons[0]!);
      bunny.finish(fresh.upload.headers.VideoId, { lengthSeconds: 600 });
      await setLessonVideo(t.id, t.lessons[0]!, fresh.asset.embedUrl);
      await setLessonVideo(t.id, t.lessons[1]!, null);

      at(0);
      await cloud.reconcileTenant(t.id); // marca «sin usar desde»
      at(30 * 60_000);
      expect((await cloud.reconcileTenant(t.id)).deleted).toBe(0); // dentro del margen
      at(25 * H * 1000);
      expect((await cloud.reconcileTenant(t.id)).deleted).toBe(2);
      expect(await asset(t.id, old.asset.id)).toMatchObject({
        status: 'DELETED',
        deleteReason: 'replaced',
      });
      expect(await asset(t.id, removed.asset.id)).toMatchObject({
        status: 'DELETED',
        deleteReason: 'removed',
      });
      expect((await asset(t.id, fresh.asset.id)).status).toBe('READY');
      expect(bunny.videos.has(old.upload.headers.VideoId)).toBe(false);
      expect(bunny.videos.has(fresh.upload.headers.VideoId)).toBe(true);
    });

    it('Bunny no borra: NO se marca borrado y se reintenta', async () => {
      const t = await seedTenant('del-retry');
      const v = await upload(t.id, t.lessons[0]!);
      bunny.finish(v.upload.headers.VideoId, { lengthSeconds: 60 });
      at(0);
      await cloud.reconcileTenant(t.id);
      at(25 * H * 1000);
      bunny.failNext.deleteVideo = new Error('Bunny 500');
      await cloud.reconcileTenant(t.id);
      expect((await asset(t.id, v.asset.id)).status).toBe('READY');
      await cloud.reconcileTenant(t.id);
      expect((await asset(t.id, v.asset.id)).status).toBe('DELETED');
    });

    it('subida abandonada (48 h sin bytes) y huérfanos de la colección', async () => {
      const t = await seedTenant('abandon');
      const v = await upload(t.id, t.lessons[0]!);
      await setLessonVideo(t.id, t.lessons[0]!, v.asset.embedUrl);
      const state = await runAsTenant(t.id, () =>
        prisma.videoTenantState.findUniqueOrThrow({ where: { tenantId: t.id } }),
      );
      const oldOrphan = bunny.orphan(state.collectionId!, realNow - 2 * DAY);
      // «Joven» respecto al reloj del test (que va 49 h por delante).
      const youngOrphan = bunny.orphan(state.collectionId!, realNow + 49 * H * 1000 - 60_000);
      at(49 * H * 1000);
      await cloud.reconcileTenant(t.id);
      expect(await asset(t.id, v.asset.id)).toMatchObject({
        status: 'DELETED',
        deleteReason: 'abandoned',
      });
      expect(bunny.videos.has(oldOrphan)).toBe(false);
      expect(bunny.videos.has(youngOrphan)).toBe(true);
    });

    it('borrar a mano: en uso, 409; sin usar, fuera', async () => {
      const t = await seedTenant('manual');
      const v = await upload(t.id, t.lessons[0]!);
      await setLessonVideo(t.id, t.lessons[0]!, v.asset.embedUrl);
      await expect(cloud.deleteAsset(t.id, randomUUID(), v.asset.id)).rejects.toMatchObject({
        status: 409,
        code: 'VIDEO_UPLOAD_IN_USE',
      });
      await setLessonVideo(t.id, t.lessons[0]!, null);
      await cloud.deleteAsset(t.id, randomUUID(), v.asset.id);
      expect((await asset(t.id, v.asset.id)).status).toBe('DELETED');
      expect(bunny.videos.has(v.upload.headers.VideoId)).toBe(false);
    });

    it('RLS: desde otra aula no se ve ni un vídeo', async () => {
      const a = await seedTenant('rls-a');
      const b = await seedTenant('rls-b');
      const v = await upload(a.id, a.lessons[0]!);
      const seenFromB = await runAsTenant(b.id, () =>
        prisma.videoAsset.findMany({ where: { bunnyGuid: v.upload.headers.VideoId } }),
      );
      expect(seenFromB).toEqual([]);
      await expect(cloud.getAsset(b.id, v.asset.id)).rejects.toMatchObject({ status: 404 });
      expect(
        await cloud.resolvePlay({ tenantId: b.id, guid: v.upload.headers.VideoId, isEditor: true }),
      ).toEqual({
        kind: 'not_ours',
      });
      // Control: desde A sí.
      expect((await cloud.getAsset(a.id, v.asset.id)).id).toBe(v.asset.id);
    });
  });

  // ─────────────────────────── inactividad ───────────────────────────

  describe('inactividad', () => {
    let drive: DriveDouble;
    let warnings: Array<{ tenantId: string; stage: number; deleteOn: Date }>;
    let archived: string[];
    let emailsSent: number;
    let alerts: string[];

    function inactivity(opts: { withDrive?: boolean } = {}) {
      return new VideoInactivityService(
        opts.withDrive === false ? { ...CONFIG, drive: null } : CONFIG,
        prisma,
        cloud,
        opts.withDrive === false ? null : drive,
        {
          warnCreator: async (input) => {
            warnings.push(input);
            return emailsSent;
          },
          operatorAlert: async (alert) => {
            alerts.push(alert);
          },
        },
        {
          archive: async (tenantId) => {
            archived.push(tenantId);
            await admin.tenant.update({ where: { id: tenantId }, data: { status: 'ARCHIVED' } });
          },
        },
        {
          now: () => clock,
          openHls: async () => ({
            container: 'ts',
            resolution: '1280x720',
            segmentCount: 2,
            chunks: (async function* () {
              yield new Uint8Array(1000);
              yield new Uint8Array(234);
            })(),
          }),
        },
      );
    }

    beforeEach(() => {
      drive = new DriveDouble();
      warnings = [];
      archived = [];
      alerts = [];
      emailsSent = 1;
    });

    async function tenantWithVideos(label: string) {
      const t = await seedTenant(label);
      const ready = await upload(t.id, t.lessons[0]!);
      bunny.finish(ready.upload.headers.VideoId, { lengthSeconds: 600 });
      await cloud.handleWebhook({ libraryId: Number(LIB), guid: ready.upload.headers.VideoId });
      await setLessonVideo(t.id, t.lessons[0]!, ready.asset.embedUrl);
      const stuck = await upload(t.id, t.lessons[1]!); // nunca terminó de subir
      return { ...t, ready, stuck };
    }

    it('10 días → aviso; 20 → aviso; 30 → sin Drive, EN SECO (no borra ni archiva)', async () => {
      const t = await tenantWithVideos('dry');
      const svc = inactivity({ withDrive: false });
      at(5 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('active');
      at(10 * DAY + H * 1000);
      expect(await svc.evaluateTenant(t.id)).toBe('warned10');
      at(11 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('waiting');
      at(20 * DAY + H * 1000);
      expect(await svc.evaluateTenant(t.id)).toBe('warned20');
      at(31 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('dry_run');
      expect(await svc.evaluateTenant(t.id)).toBe('dry_run');

      expect(warnings.map((w) => w.stage)).toEqual([10, 20]);
      // El primer aviso fija el borrado a los 30 días de la última actividad.
      expect(warnings[0]!.deleteOn.getTime()).toBeGreaterThanOrEqual(realNow + 30 * DAY - 1000);
      expect(archived).toEqual([]);
      expect(bunny.videos.has(t.ready.upload.headers.VideoId)).toBe(true);
      const state = await runAsTenant(t.id, () =>
        prisma.videoTenantState.findUniqueOrThrow({ where: { tenantId: t.id } }),
      );
      expect(state.purgeBlockedReason).toMatch(/Google Drive/);
      expect(state.purgedAt).toBeNull();
      // Auditado UNA vez aunque el barrido se repita.
      const blocked = await admin.auditLog.count({
        where: { tenantId: t.id, action: 'video.inactivity.blocked' },
      });
      expect(blocked).toBe(1);
    });

    it('30 días con Drive: copia, borra en Bunny, archiva; a los 90 días borra la copia', async () => {
      const t = await tenantWithVideos('purge');
      const svc = inactivity();
      for (const d of [10, 20, 30]) {
        at(d * DAY + H * 1000);
        await svc.evaluateTenant(t.id);
      }
      expect(archived).toEqual([t.id]);
      expect(bunny.videos.has(t.ready.upload.headers.VideoId)).toBe(false);
      expect(bunny.videos.has(t.stuck.upload.headers.VideoId)).toBe(false);
      const ready = await asset(t.id, t.ready.asset.id);
      expect(ready).toMatchObject({
        status: 'DELETED',
        deleteReason: 'inactivity',
        backupBytes: 1234n,
      });
      expect(ready.backupDriveFileId).toMatch(/^drive-/);
      expect(ready.backupExpiresAt!.getTime() - ready.backupAt!.getTime()).toBe(90 * DAY);
      const file = drive.files.get(ready.backupDriveFileId!)!;
      expect(file.name).toBe(`DC_${t.slug}__${t.ready.upload.headers.VideoId}__Clase 1.ts`);
      expect(file.app).toMatchObject({
        didactaTenantId: t.id,
        didactaPurpose: 'inactivity-backup',
      });
      // Lo que nunca terminó de subir no tiene nada que copiar.
      expect((await asset(t.id, t.stuck.asset.id)).backupDriveFileId).toBeNull();
      expect(await cloud.tenantsWithVideo()).not.toContain(t.id);

      at(30 * DAY + 89 * DAY);
      expect(await svc.expireBackups()).toBe(0);
      at(30 * DAY + 91 * DAY);
      expect(await svc.expireBackups()).toBe(1);
      expect(drive.files.size).toBe(0);
      expect((await asset(t.id, t.ready.asset.id)).backupDeletedAt).not.toBeNull();
      const actions = (
        await admin.auditLog.findMany({ where: { tenantId: t.id }, select: { action: true } })
      ).map((r) => r.action);
      for (const a of [
        'video.inactivity.warned',
        'video.backup.created',
        'video.upload.deleted',
        'video.inactivity.purged',
        'video.backup.deleted',
      ]) {
        expect(actions).toContain(a);
      }
    });

    it('si la copia falla, no se borra NADA', async () => {
      const t = await tenantWithVideos('backup-fail');
      const svc = inactivity();
      for (const d of [10, 20]) {
        at(d * DAY + H * 1000);
        await svc.evaluateTenant(t.id);
      }
      drive.failUpload = new Error('cuota de Drive agotada');
      at(31 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('blocked');
      expect(bunny.videos.has(t.ready.upload.headers.VideoId)).toBe(true);
      expect(bunny.videos.has(t.stuck.upload.headers.VideoId)).toBe(true);
      expect(archived).toEqual([]);
      // Al día siguiente, con Drive bien, sigue donde se quedó.
      drive.failUpload = null;
      at(32 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('purged');
    });

    it('sin correo enviado no hay aviso (y sin aviso, nunca se llega a borrar)', async () => {
      const t = await tenantWithVideos('no-smtp');
      const svc = inactivity();
      emailsSent = 0;
      for (const d of [10, 20, 31, 45]) {
        at(d * DAY + H * 1000);
        expect(await svc.evaluateTenant(t.id)).toBe('waiting');
      }
      expect(archived).toEqual([]);
    });

    it('un aula ya parada al encenderlo: 10 días entre avisos y antes de borrar', async () => {
      const t = await tenantWithVideos('late');
      const svc = inactivity();
      at(40 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('warned10');
      expect(warnings[0]!.deleteOn.getTime()).toBe(clock.getTime() + 20 * DAY);
      at(41 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('waiting');
      at(50 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('warned20');
      at(55 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('waiting');
      at(60 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('purged');
    });

    it('si alguien vuelve a entrar, el ciclo se reinicia', async () => {
      const t = await tenantWithVideos('back');
      const svc = inactivity();
      at(10 * DAY + H * 1000);
      expect(await svc.evaluateTenant(t.id)).toBe('warned10');
      await admin.user.create({
        data: {
          tenantId: t.id,
          email: `alumno-${randomUUID()}@x.test`,
          lastLoginAt: new Date(realNow + 12 * DAY),
        },
      });
      at(13 * DAY);
      expect(await svc.evaluateTenant(t.id)).toBe('active');
      const state = await runAsTenant(t.id, () =>
        prisma.videoTenantState.findUniqueOrThrow({ where: { tenantId: t.id } }),
      );
      expect(state).toMatchObject({ warned10At: null, lastActivitySource: 'login' });
    });

    it('fuentes de actividad: venta, sesión refrescada y suscripción viva', async () => {
      const t = await tenantWithVideos('sources');
      const svc = inactivity();
      const created = (await admin.tenant.findUniqueOrThrow({ where: { id: t.id } })).createdAt;

      at(40 * DAY);
      await addSale(t.id, 100);
      await admin.modPayoutsSale.updateMany({
        where: { tenantId: t.id },
        data: { chargedAt: new Date(realNow + 35 * DAY) },
      });
      expect(await svc.lastActivity(t.id, created)).toMatchObject({ source: 'sale' });

      const user = await admin.user.create({
        data: { tenantId: t.id, email: `c-${randomUUID()}@x.test` },
      });
      await admin.session.create({
        data: {
          tenantId: t.id,
          userId: user.id,
          tokenHash: randomBytes(16).toString('hex'),
          // Refrescada hace 2 días: caduca dentro de 28.
          expiresAt: new Date(realNow + 38 * DAY + 30 * DAY),
          createdAt: new Date(realNow),
        },
      });
      const viaSession = await svc.lastActivity(t.id, created);
      expect(viaSession.source).toBe('session');
      expect(viaSession.at.getTime()).toBe(realNow + 38 * DAY);

      await admin.modSubscriptionsSubscription.create({
        data: {
          tenantId: t.id,
          userId: user.id,
          stripeCustomerId: 'cus_x',
          stripePriceId: 'price_x',
          status: 'ACTIVE',
          unitAmount: 1000,
          interval: 'month',
        },
      });
      expect(await svc.lastActivity(t.id, created)).toEqual({ at: clock, source: 'subscription' });
    });

    it('supresión (RGPD): borra YA todas las copias del aula', async () => {
      const t = await tenantWithVideos('rgpd');
      const svc = inactivity();
      for (const d of [10, 20, 30]) {
        at(d * DAY + H * 1000);
        await svc.evaluateTenant(t.id);
      }
      expect(drive.files.size).toBe(1);
      expect(
        await svc.deleteBackups(t.id, { onlyExpired: false, reason: 'erasure_request' }),
      ).toEqual({
        deleted: 1,
        failed: 0,
      });
      expect(drive.files.size).toBe(0);
      // Idempotente.
      expect(
        await svc.deleteBackups(t.id, { onlyExpired: false, reason: 'erasure_request' }),
      ).toEqual({
        deleted: 0,
        failed: 0,
      });
    });

    it('aviso al operador si el vídeo cuesta más del 30 % de la comisión (una vez al mes)', async () => {
      const t = await tenantWithVideos('cost');
      await addSale(t.id, 1200); // 12 € de comisión al año → 1 €/mes
      await admin.videoAsset.updateMany({
        where: { tenantId: t.id },
        data: { storageBytes: BigInt(50e9) }, // 2 × 50 GB × 0,02 = 2 €/mes
      });
      at(2 * 60_000);
      const svc = inactivity();
      expect(await svc.checkCost(t.id)).toBe(true);
      expect(await svc.checkCost(t.id)).toBe(false);
      expect(alerts).toEqual(['video.cost_over_commission']);
    });
  });
});
