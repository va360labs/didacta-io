/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaTenantConfigService } from '../modules/prisma-tenant-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { BUNNY_GUID_RE, BUNNY_LIBRARY_ID_RE, BUNNY_LIBRARY_IN_URL_PATTERN } from './bunny-embed';
import { VIDEO_CLOUD_LIBRARY, type CloudVideoLibrary } from './cloud/video-cloud.tokens';

/** Scope del `tenant_setting`: la protección de vídeo es infra del host, no de un módulo. */
export const VIDEO_PROTECTION_SCOPE = 'video-protection';
/**
 * Claves de firma, cifradas (AES-256-GCM vía `SecretCipherService`). Forma:
 * `{ libraries: { [libraryId]: { signingSecret } } }`.
 *
 * El nombre del campo NO es casual: `signingSecret` está en la lista de campos
 * sensibles de `redact-sensitive-fields.ts`, así que el `GET` genérico de
 * `/tenant-settings/:scope/:key` lo devuelve redactado. Con un mapa plano
 * `{ [libraryId]: clave }` ese endpoint le devolvería la clave en claro a
 * cualquier admin del tenant, y la clave no debe volver a salir de la API.
 */
export const BUNNY_KEYS_SETTING = 'bunny-keys';
/** Ajustes no secretos: interruptor, tope por cuenta y marca de agua. */
export const VIDEO_SETTINGS_SETTING = 'settings';
/** Resultado de la última comprobación real de cada librería (no secreto). */
export const BUNNY_CHECKS_SETTING = 'bunny-checks';

export interface VideoProtectionSettings {
  /**
   * Interruptor del tenant. Con una clave guardada y esto en `false`, las URL
   * vuelven a salir sin firmar (y sin tope ni marca de agua): es la forma de
   * apagar la protección sin perder la clave.
   */
  enabled: boolean;
  /** Vídeos DISTINTOS que una cuenta puede abrir en una hora. */
  maxVideosPerHour: number;
  /** Vídeos DISTINTOS que una cuenta puede abrir en 24 horas. */
  maxVideosPerDay: number;
  /** Marca de agua con la identidad del alumno sobre el reproductor. */
  watermark: boolean;
}

/**
 * Valores por defecto. Un alumno no abre 30 vídeos distintos en una hora; un
 * script que recorre el catálogo sí. Repetir un vídeo ya abierto no cuenta.
 */
export const DEFAULT_VIDEO_PROTECTION_SETTINGS: VideoProtectionSettings = {
  enabled: true,
  maxVideosPerHour: 30,
  maxVideosPerDay: 100,
  watermark: true,
};

/** Cotas de lo que un admin puede configurar como tope. */
export const VIDEO_LIMIT_BOUNDS = {
  perHour: { min: 1, max: 1_000 },
  perDay: { min: 1, max: 10_000 },
} as const;

export type SignatureCheckOutcome =
  | 'ok'
  | 'not_enforced'
  | 'rejected'
  | 'video_unavailable'
  | 'unreachable';

export interface StoredSignatureCheck {
  outcome: SignatureCheckOutcome;
  checkedAt: string;
}

export interface VideoLibraryStatus {
  libraryId: string;
  /** Tiene clave de firma guardada. */
  configured: boolean;
  /** Aparece en algún vídeo de los cursos del tenant. */
  inUse: boolean;
  /** Última comprobación real contra Bunny, o null si nunca se ha comprobado. */
  lastCheck: StoredSignatureCheck | null;
}

export interface VideoProtectionStatus {
  /** Interruptor del tenant. */
  enabled: boolean;
  /** `enabled` y al menos una librería con clave: hay URLs saliendo firmadas. */
  active: boolean;
  watermark: boolean;
  limits: { perHour: number; perDay: number };
  libraries: VideoLibraryStatus[];
}

/** Protección aplicable a UNA librería del tenant. */
export interface LibraryProtection {
  /** `settings.enabled` y la librería tiene clave. */
  active: boolean;
  tokenKey: string | null;
  settings: VideoProtectionSettings;
}

interface StoredKeys {
  libraries?: Record<string, { signingSecret?: unknown } | undefined>;
}

type TokenKeyMap = Record<string, string>;
type CheckMap = Record<string, StoredSignatureCheck>;

/**
 * Las claves se descifran y los ajustes se leen en cada reproducción: se
 * cachean un minuto por tenant. Con varias réplicas, un cambio hecho en una
 * tarda como mucho ese minuto en verse en las demás.
 */
const CACHE_TTL_MS = 60_000;
/** Tope de tenants en caché: en un despliegue con miles de academias no crece sin fin. */
const CACHE_MAX_TENANTS = 5_000;

const SIGNATURE_CHECK_OUTCOMES: ReadonlySet<string> = new Set([
  'ok',
  'not_enforced',
  'rejected',
  'video_unavailable',
  'unreachable',
]);

function clampInt(raw: unknown, fallback: number, bounds: { min: number; max: number }): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, raw));
}

/**
 * Lo guardado → ajustes válidos. Campo a campo: un valor ausente o que no
 * encaja cae a su valor por defecto sin arrastrar a los demás. Hace falta
 * porque el `PUT` genérico de `/tenant-settings` deja escribir cualquier JSON
 * en este scope, y un tope a `0` o una cadena donde va un número no pueden
 * dejar a un tenant sin vídeos.
 */
export function normalizeVideoProtectionSettings(raw: unknown): VideoProtectionSettings {
  const d = DEFAULT_VIDEO_PROTECTION_SETTINGS;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...d };
  const r = raw as Record<string, unknown>;
  const perHour = clampInt(r['maxVideosPerHour'], d.maxVideosPerHour, VIDEO_LIMIT_BOUNDS.perHour);
  const perDay = clampInt(r['maxVideosPerDay'], d.maxVideosPerDay, VIDEO_LIMIT_BOUNDS.perDay);
  return {
    enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : d.enabled,
    watermark: typeof r['watermark'] === 'boolean' ? r['watermark'] : d.watermark,
    maxVideosPerHour: perHour,
    // Un tope diario por debajo del horario no tiene sentido: manda el horario.
    maxVideosPerDay: Math.max(perDay, perHour),
  };
}

/**
 * Configuración de la protección de vídeo de cada tenant: claves de firma de
 * sus librerías de Bunny Stream, interruptor, tope por cuenta y marca de agua.
 *
 * Todo vive en `tenant_setting` (RLS por tenant), como las credenciales de
 * Stripe o SMTP. No hay variable de entorno de respaldo a propósito: una clave
 * global firmaría los vídeos de CUALQUIER academia del servidor, y bastaría con
 * que un tenant pegase en una lección la URL de un vídeo ajeno para que la API
 * se lo firmase. La clave la pone el admin de cada tenant desde su panel.
 */
@Injectable()
export class VideoProtectionConfigService {
  private readonly logger = new Logger(VideoProtectionConfigService.name);
  private readonly cache = new Map<
    string,
    { keys: TokenKeyMap; settings: VideoProtectionSettings; expiresAt: number }
  >();

  constructor(
    private readonly config: PrismaTenantConfigService,
    private readonly prisma: PrismaService,
    /** Solo con la subida de vídeo de Didacta Cloud encendida. */
    @Optional() @Inject(VIDEO_CLOUD_LIBRARY) private readonly cloud?: CloudVideoLibrary,
  ) {}

  /**
   * ¿Es la biblioteca de Didacta Cloud? Esa la firma el servidor con la clave
   * del operador: no es del aula, no sale en su panel y el aula no puede
   * guardarle una clave.
   */
  isPlatformLibrary(libraryId: string): boolean {
    return Boolean(this.cloud && this.cloud.libraryId === libraryId);
  }

  /** Qué protección toca aplicar a un vídeo de esta librería del tenant. */
  async resolveLibrary(tenantId: string, libraryId: string): Promise<LibraryProtection> {
    const { keys, settings } = await this.load(tenantId);
    const tokenKey = keys[libraryId] ?? null;
    return { active: settings.enabled && tokenKey !== null, tokenKey, settings };
  }

  async getSettings(tenantId: string): Promise<VideoProtectionSettings> {
    return (await this.load(tenantId)).settings;
  }

  /** La clave de una librería, sin pasar por el interruptor (para comprobarla). */
  async getTokenKey(tenantId: string, libraryId: string): Promise<string | null> {
    return (await this.load(tenantId)).keys[libraryId] ?? null;
  }

  async updateSettings(
    tenantId: string,
    actorId: string,
    patch: Partial<VideoProtectionSettings>,
  ): Promise<VideoProtectionSettings> {
    const current = await this.readSettings(tenantId);
    const next = normalizeVideoProtectionSettings({ ...current, ...patch });
    await this.config.set(tenantId, VIDEO_PROTECTION_SCOPE, VIDEO_SETTINGS_SETTING, next, {
      isSecret: false,
      actorId,
    });
    this.cache.delete(tenantId);
    return next;
  }

  /**
   * Guarda (cifrada) la clave de una librería, conservando las de las demás.
   * Olvida la última comprobación de esa librería: con una clave nueva, lo que
   * se comprobó con la anterior ya no dice nada.
   */
  async setTokenKey(
    tenantId: string,
    actorId: string,
    libraryId: string,
    tokenKey: string,
  ): Promise<void> {
    const current = await this.readKeys(tenantId);
    const libraries: Record<string, { signingSecret: string }> = {};
    for (const [id, key] of Object.entries({ ...current, [libraryId]: tokenKey })) {
      libraries[id] = { signingSecret: key };
    }
    await this.config.set(
      tenantId,
      VIDEO_PROTECTION_SCOPE,
      BUNNY_KEYS_SETTING,
      { libraries },
      { isSecret: true, actorId },
    );
    this.cache.delete(tenantId);

    const checks = await this.readChecks(tenantId);
    if (checks[libraryId]) {
      const { [libraryId]: _dropped, ...rest } = checks;
      await this.config.set(tenantId, VIDEO_PROTECTION_SCOPE, BUNNY_CHECKS_SETTING, rest, {
        isSecret: false,
        actorId,
      });
    }
  }

  async recordCheck(
    tenantId: string,
    actorId: string,
    libraryId: string,
    check: StoredSignatureCheck,
  ): Promise<void> {
    const checks = await this.readChecks(tenantId);
    await this.config.set(
      tenantId,
      VIDEO_PROTECTION_SCOPE,
      BUNNY_CHECKS_SETTING,
      { ...checks, [libraryId]: check },
      { isSecret: false, actorId },
    );
  }

  /**
   * Estado para el panel: interruptor, tope, marca de agua y las librerías de
   * Bunny del tenant (las que aparecen en sus cursos más las que ya tienen
   * clave). Nunca incluye una clave.
   */
  async status(tenantId: string): Promise<VideoProtectionStatus> {
    const [keys, settings, checks, inUse] = await Promise.all([
      this.readKeys(tenantId),
      this.readSettings(tenantId),
      this.readChecks(tenantId),
      this.librariesInUse(tenantId),
    ]);
    const ids = new Set<string>([...Object.keys(keys), ...inUse]);
    for (const id of [...ids]) if (this.isPlatformLibrary(id)) ids.delete(id);
    const libraries = [...ids]
      .sort((a, b) => Number(a) - Number(b))
      .map((libraryId) => ({
        libraryId,
        configured: Boolean(keys[libraryId]),
        inUse: inUse.has(libraryId),
        lastCheck: keys[libraryId] ? (checks[libraryId] ?? null) : null,
      }));
    return {
      enabled: settings.enabled,
      active: settings.enabled && libraries.some((l) => l.configured),
      watermark: settings.watermark,
      limits: { perHour: settings.maxVideosPerHour, perDay: settings.maxVideosPerDay },
      libraries,
    };
  }

  /**
   * Un vídeo cualquiera de esa librería sacado de los cursos del tenant, para
   * comprobar la firma contra algo que existe de verdad en Bunny. Null si el
   * tenant aún no tiene ningún vídeo de esa librería.
   */
  async findSampleVideo(tenantId: string, libraryId: string): Promise<string | null> {
    if (!BUNNY_LIBRARY_ID_RE.test(libraryId)) return null;
    const pattern = `mediadelivery\\.net/(?:embed|play)/${libraryId}/([0-9a-fA-F-]{36})`;
    const like = `%mediadelivery.net/%/${libraryId}/%`;
    // Va en un `$transaction` por lotes y no suelta: la extensión de RLS solo
    // envuelve operaciones de MODELO; una consulta cruda suelta correría sin
    // `app.current_tenant_id` y, con RLS forzada, no vería ni una fila.
    const [rows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<Array<{ guid: string | null }>>`
        SELECT guid FROM (
          SELECT (regexp_matches(l.content::text, ${pattern}))[1] AS guid
            FROM mod_courses_lesson l
           WHERE l.tenant_id = ${tenantId}::uuid
             AND l.deleted_at IS NULL
             AND l.content::text LIKE ${like}
          UNION ALL
          SELECT (regexp_matches(c.featured_video_url, ${pattern}))[1]
            FROM mod_courses_course c
           WHERE c.tenant_id = ${tenantId}::uuid
             AND c.deleted_at IS NULL
             AND c.featured_video_url LIKE ${like}
        ) found
        LIMIT 20`,
    ]);
    for (const row of rows) {
      if (row.guid && BUNNY_GUID_RE.test(row.guid)) return row.guid.toLowerCase();
    }
    return null;
  }

  /**
   * Librerías de Bunny que aparecen en las lecciones y en los vídeos
   * destacados del tenant. Lectura filtrada por tenant: solo mira URLs, no
   * escribe nada de mod.courses.
   */
  private async librariesInUse(tenantId: string): Promise<Set<string>> {
    const [rows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<Array<{ lib: string | null }>>`
        SELECT (regexp_matches(l.content::text, ${BUNNY_LIBRARY_IN_URL_PATTERN}, 'g'))[1] AS lib
          FROM mod_courses_lesson l
         WHERE l.tenant_id = ${tenantId}::uuid
           AND l.deleted_at IS NULL
           AND l.content::text LIKE '%mediadelivery.net/%'
        UNION
        SELECT (regexp_matches(c.featured_video_url, ${BUNNY_LIBRARY_IN_URL_PATTERN}, 'g'))[1]
          FROM mod_courses_course c
         WHERE c.tenant_id = ${tenantId}::uuid
           AND c.deleted_at IS NULL
           AND c.featured_video_url LIKE '%mediadelivery.net/%'`,
    ]);
    const ids = new Set<string>();
    for (const r of rows) if (r.lib && BUNNY_LIBRARY_ID_RE.test(r.lib)) ids.add(r.lib);
    return ids;
  }

  private async load(
    tenantId: string,
  ): Promise<{ keys: TokenKeyMap; settings: VideoProtectionSettings }> {
    const now = Date.now();
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > now) return hit;
    const [keys, settings] = await Promise.all([
      this.readKeys(tenantId),
      this.readSettings(tenantId),
    ]);
    if (this.cache.size >= CACHE_MAX_TENANTS) this.pruneCache(now);
    this.cache.set(tenantId, { keys, settings, expiresAt: now + CACHE_TTL_MS });
    return { keys, settings };
  }

  private pruneCache(now: number): void {
    for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
    if (this.cache.size >= CACHE_MAX_TENANTS) this.cache.clear();
  }

  /**
   * Si lo guardado no se puede descifrar (cambió `TENANT_SETTINGS_ENC_KEY` o
   * la fila está dañada) se trata como «sin clave» y se avisa en el log. Que
   * lanzase daría 500 en TODOS los vídeos del tenant y, peor, el admin no
   * podría arreglarlo volviendo a guardar la clave: guardar también lee.
   */
  private async readKeys(tenantId: string): Promise<TokenKeyMap> {
    let stored: StoredKeys | undefined;
    try {
      stored = await this.config.get<StoredKeys>(
        tenantId,
        VIDEO_PROTECTION_SCOPE,
        BUNNY_KEYS_SETTING,
      );
    } catch (err) {
      this.logger.error(
        `No se pudo descifrar la clave de firma de vídeo del tenant ${tenantId}: ` +
          `${(err as Error).message.slice(0, 200)}. Se trata como «sin clave»; ` +
          'hay que volver a guardarla en Administración → Seguridad.',
      );
      return {};
    }
    const libraries = stored?.libraries;
    if (!libraries || typeof libraries !== 'object' || Array.isArray(libraries)) return {};
    const out: TokenKeyMap = {};
    for (const [libraryId, entry] of Object.entries(libraries)) {
      const key = entry?.signingSecret;
      if (BUNNY_LIBRARY_ID_RE.test(libraryId) && typeof key === 'string' && key.length > 0) {
        out[libraryId] = key;
      }
    }
    return out;
  }

  private async readSettings(tenantId: string): Promise<VideoProtectionSettings> {
    let raw: unknown;
    try {
      raw = await this.config.get(tenantId, VIDEO_PROTECTION_SCOPE, VIDEO_SETTINGS_SETTING);
    } catch {
      raw = undefined;
    }
    return normalizeVideoProtectionSettings(raw);
  }

  private async readChecks(tenantId: string): Promise<CheckMap> {
    let raw: unknown;
    try {
      raw = await this.config.get(tenantId, VIDEO_PROTECTION_SCOPE, BUNNY_CHECKS_SETTING);
    } catch {
      raw = undefined;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: CheckMap = {};
    for (const [libraryId, entry] of Object.entries(raw as Record<string, unknown>)) {
      const e = entry as { outcome?: unknown; checkedAt?: unknown } | null;
      if (
        e &&
        typeof e.outcome === 'string' &&
        SIGNATURE_CHECK_OUTCOMES.has(e.outcome) &&
        typeof e.checkedAt === 'string'
      ) {
        out[libraryId] = {
          outcome: e.outcome as SignatureCheckOutcome,
          checkedAt: e.checkedAt,
        };
      }
    }
    return out;
  }
}
