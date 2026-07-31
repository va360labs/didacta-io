/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PrismaClient } from '@didacta/database';
import {
  ResourcesForbiddenError,
  ResourcesNotFoundError,
  ResourcesValidationError,
} from './errors.js';

/**
 * mod.resources — dominio puro (sin NestJS). Biblioteca de recursos del tenant
 * organizada en COLECCIONES con portada propia ("Workflows de clase", "Skills
 * y agentes"…). Cualquier miembro comparte recursos; el staff gestiona las
 * colecciones. Las 6 colecciones por defecto se siembran perezosamente en el
 * primer listado del tenant (runtime — el flujo de despliegue es db push y las
 * migraciones de datos no se ejecutan solas).
 */

export interface ResourcesEventPublisher {
  publish(
    tenantId: string,
    actorId: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export const RESOURCES_EVENT = {
  CREATED: 'resources.resource.created',
  DELETED: 'resources.resource.deleted',
  COLLECTION_CREATED: 'resources.collection.created',
} as const;

export type ResourceKindValue = 'FILE' | 'LINK';

/** Colecciones sembradas por defecto para cada tenant (editables). */
export const DEFAULT_COLLECTIONS: ReadonlyArray<{ title: string; description: string }> = [
  {
    title: 'Workflows de clase',
    description: 'Los flujos completos que montamos en directo, listos para importar.',
  },
  {
    title: 'Skills y agentes',
    description: 'Habilidades listas para instalar en tu asistente y ponerlo a trabajar.',
  },
  {
    title: 'Herramientas de IA',
    description: 'Directorio de herramientas útiles, clasificadas por para qué sirven.',
  },
  {
    title: 'Plantillas y sistemas',
    description: 'Plantillas de Notion, hojas y documentos listos para duplicar.',
  },
  {
    title: 'Guías y contratos',
    description: 'Guías prácticas y modelos de contrato listos para usar con clientes.',
  },
  {
    title: 'Casos y resultados',
    description: 'Casos reales de la comunidad con el antes, el después y los números.',
  },
];

const TITLE_MIN = 3;
const TITLE_MAX = 160;
const DESCRIPTION_MAX = 1000;
const LIST_LIMIT = 200;

export interface CollectionView {
  id: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  isDefault: boolean;
  resourceCount: number;
}

export interface ResourceView {
  id: string;
  collectionId: string;
  kind: string;
  title: string;
  description: string | null;
  url: string;
  fileName: string | null;
  createdById: string;
  downloadCount: number;
  createdAt: Date;
}

export interface CreateResourceInput {
  tenantId: string;
  createdById: string;
  collectionId: string;
  kind: ResourceKindValue;
  title: string;
  description?: string | null;
  url: string;
  fileName?: string | null;
  zoomSessionId?: string | null;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** Violación de FK (P2003): la fila referenciada desapareció en una carrera. */
function isFkViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2003';
}

function validateTitle(raw: string): string {
  const title = raw.trim();
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    throw new ResourcesValidationError(
      `El título debe tener entre ${TITLE_MIN} y ${TITLE_MAX} caracteres.`,
    );
  }
  return title;
}

function validateDescription(raw: string | null | undefined): string | null {
  const description = raw?.trim() || null;
  if (description && description.length > DESCRIPTION_MAX) {
    throw new ResourcesValidationError(
      `La descripción no puede superar ${DESCRIPTION_MAX} caracteres.`,
    );
  }
  return description;
}

/** Único prefijo local admitido: ficheros del storage del propio tenant. */
const LOCAL_STORAGE_PREFIX = '/api/v1/storage/file/';

/**
 * LINK debe ser http(s) absoluto; FILE (y las portadas) admiten además rutas
 * del propio storage, y SOLO de ahí: un path local arbitrario permitiría
 * apuntar a rutas de la app, y `//host` (protocol-relative) saldría del origen.
 */
function validateUrl(raw: string, allowLocalPath: boolean): string {
  const url = raw.trim();
  if (url.startsWith('/')) {
    if (allowLocalPath && url.startsWith(LOCAL_STORAGE_PREFIX)) return url;
    throw new ResourcesValidationError('La URL no es válida.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ResourcesValidationError('La URL no es válida.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ResourcesValidationError('La URL debe ser http(s).');
  }
  return url;
}

export class ResourcesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: ResourcesEventPublisher,
  ) {}

  // ── Colecciones ────────────────────────────────────────────────────────────

  /**
   * Colecciones del tenant con nº de recursos. Si el tenant aún no tiene
   * ninguna, siembra las 6 por defecto (idempotente: la unique tenant+title
   * absorbe la carrera entre dos primeros listados simultáneos).
   */
  async listCollections(tenantId: string): Promise<CollectionView[]> {
    let collections = await this.fetchCollections(tenantId);
    if (collections.length === 0) {
      await this.seedDefaults(tenantId);
      collections = await this.fetchCollections(tenantId);
    }
    return collections;
  }

  async createCollection(args: {
    tenantId: string;
    createdById: string;
    title: string;
    description?: string | null;
    coverUrl?: string | null;
  }): Promise<CollectionView> {
    const title = validateTitle(args.title);
    const description = validateDescription(args.description);
    const coverUrl = args.coverUrl?.trim() ? validateUrl(args.coverUrl, true) : null;
    try {
      const collection = await this.prisma.modResourcesCollection.create({
        data: {
          tenantId: args.tenantId,
          title,
          description,
          coverUrl,
          // Al final de la parrilla: detrás de las sembradas (0-5).
          sortOrder: 100,
        },
      });
      await this.publisher.publish(
        args.tenantId,
        args.createdById,
        RESOURCES_EVENT.COLLECTION_CREATED,
        { collectionId: collection.id, title },
      );
      return {
        id: collection.id,
        title: collection.title,
        description: collection.description,
        coverUrl: collection.coverUrl,
        isDefault: collection.isDefault,
        resourceCount: 0,
      };
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ResourcesValidationError('Ya existe una colección con ese título.');
      }
      throw e;
    }
  }

  async updateCollection(
    tenantId: string,
    collectionId: string,
    patch: { title?: string; description?: string | null; coverUrl?: string | null },
  ): Promise<CollectionView> {
    const existing = await this.prisma.modResourcesCollection.findFirst({
      where: { id: collectionId, tenantId },
      include: { _count: { select: { resources: true } } },
    });
    if (!existing) throw new ResourcesNotFoundError();

    const title = patch.title === undefined ? undefined : validateTitle(patch.title);
    const description =
      patch.description === undefined ? undefined : validateDescription(patch.description);
    const coverUrl =
      patch.coverUrl === undefined
        ? undefined
        : patch.coverUrl?.trim()
          ? validateUrl(patch.coverUrl, true)
          : null;

    try {
      const updated = await this.prisma.modResourcesCollection.update({
        where: { id: collectionId },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(coverUrl !== undefined ? { coverUrl } : {}),
        },
      });
      return {
        id: updated.id,
        title: updated.title,
        description: updated.description,
        coverUrl: updated.coverUrl,
        isDefault: updated.isDefault,
        resourceCount: existing._count.resources,
      };
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ResourcesValidationError('Ya existe una colección con ese título.');
      }
      throw e;
    }
  }

  /** Borra una colección VACÍA (con recursos dentro es un error, no un cascade). */
  async deleteCollection(tenantId: string, collectionId: string): Promise<void> {
    const existing = await this.prisma.modResourcesCollection.findFirst({
      where: { id: collectionId, tenantId },
      include: { _count: { select: { resources: true } } },
    });
    if (!existing) throw new ResourcesNotFoundError();
    if (existing._count.resources > 0) {
      throw new ResourcesValidationError(
        'La colección tiene recursos. Muévelos o bórralos antes de eliminarla.',
      );
    }
    try {
      await this.prisma.modResourcesCollection.deleteMany({
        where: { id: collectionId, tenantId },
      });
    } catch (e) {
      // Carrera: alguien compartió un recurso entre el count y el delete. La FK
      // Restrict lo frena en BD; lo devolvemos como el mismo error de dominio.
      if (isFkViolation(e)) {
        throw new ResourcesValidationError(
          'La colección tiene recursos. Muévelos o bórralos antes de eliminarla.',
        );
      }
      throw e;
    }
  }

  /** Detalle de colección + recursos (con buscador opcional dentro de ella). */
  async getCollection(
    tenantId: string,
    collectionId: string,
    filter: { q?: string } = {},
  ): Promise<{ collection: CollectionView; resources: ResourceView[] }> {
    const collection = await this.prisma.modResourcesCollection.findFirst({
      where: { id: collectionId, tenantId },
      include: { _count: { select: { resources: true } } },
    });
    if (!collection) throw new ResourcesNotFoundError();

    const q = filter.q?.trim();
    const resources = await this.prisma.modResourcesResource.findMany({
      where: {
        tenantId,
        collectionId,
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });

    return {
      collection: {
        id: collection.id,
        title: collection.title,
        description: collection.description,
        coverUrl: collection.coverUrl,
        isDefault: collection.isDefault,
        resourceCount: collection._count.resources,
      },
      resources: resources.map((r) => this.toView(r)),
    };
  }

  // ── Recursos ───────────────────────────────────────────────────────────────

  /** Cualquier miembro comparte; la colección debe existir en su tenant. */
  async create(input: CreateResourceInput): Promise<ResourceView> {
    const title = validateTitle(input.title);
    const description = validateDescription(input.description);
    const url = validateUrl(input.url, input.kind === 'FILE');

    const collection = await this.prisma.modResourcesCollection.findFirst({
      where: { id: input.collectionId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!collection) throw new ResourcesNotFoundError();

    let resource;
    try {
      resource = await this.prisma.modResourcesResource.create({
        data: {
          tenantId: input.tenantId,
          collectionId: input.collectionId,
          kind: input.kind,
          title,
          description,
          url,
          fileName: input.kind === 'FILE' ? (input.fileName?.trim() ?? null) : null,
          zoomSessionId: input.zoomSessionId ?? null,
          createdById: input.createdById,
        },
      });
    } catch (e) {
      // Carrera: la colección se borró entre el check y el insert (FK P2003).
      if (isFkViolation(e)) throw new ResourcesNotFoundError();
      throw e;
    }

    await this.publisher.publish(input.tenantId, input.createdById, RESOURCES_EVENT.CREATED, {
      resourceId: resource.id,
      collectionId: input.collectionId,
      kind: resource.kind,
    });

    return this.toView(resource);
  }

  /**
   * Registra una descarga/apertura y devuelve la URL. El contador es el dato
   * que dice qué recursos funcionan (y alimenta futuros retos del bloque 1).
   */
  async registerDownload(tenantId: string, resourceId: string): Promise<{ url: string }> {
    const resource = await this.prisma.modResourcesResource.findFirst({
      where: { id: resourceId, tenantId },
      select: { url: true },
    });
    if (!resource) throw new ResourcesNotFoundError();
    await this.prisma.modResourcesResource.updateMany({
      where: { id: resourceId, tenantId },
      data: { downloadCount: { increment: 1 } },
    });
    return { url: resource.url };
  }

  /**
   * Borra un recurso. El autor puede borrar lo suyo; el staff, cualquiera
   * (`actor.isStaff`).
   */
  async remove(
    tenantId: string,
    resourceId: string,
    actor: { id: string; isStaff: boolean },
  ): Promise<void> {
    const existing = await this.prisma.modResourcesResource.findFirst({
      where: { id: resourceId, tenantId },
      select: { createdById: true },
    });
    if (!existing) throw new ResourcesNotFoundError();
    if (!actor.isStaff && existing.createdById !== actor.id) {
      throw new ResourcesForbiddenError();
    }
    await this.prisma.modResourcesResource.deleteMany({ where: { id: resourceId, tenantId } });
    await this.publisher.publish(tenantId, actor.id, RESOURCES_EVENT.DELETED, { resourceId });
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  private async fetchCollections(tenantId: string): Promise<CollectionView[]> {
    const collections = await this.prisma.modResourcesCollection.findMany({
      where: { tenantId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { resources: true } } },
    });
    return collections.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      coverUrl: c.coverUrl,
      isDefault: c.isDefault,
      resourceCount: c._count.resources,
    }));
  }

  private async seedDefaults(tenantId: string): Promise<void> {
    for (const [i, def] of DEFAULT_COLLECTIONS.entries()) {
      try {
        await this.prisma.modResourcesCollection.create({
          data: {
            tenantId,
            title: def.title,
            description: def.description,
            sortOrder: i,
            isDefault: true,
          },
        });
      } catch (e) {
        // Carrera entre dos primeros listados: el otro ya la sembró.
        if (!isUniqueViolation(e)) throw e;
      }
    }
  }

  private toView(r: {
    id: string;
    collectionId: string;
    kind: string;
    title: string;
    description: string | null;
    url: string;
    fileName: string | null;
    createdById: string;
    downloadCount: number;
    createdAt: Date;
  }): ResourceView {
    return {
      id: r.id,
      collectionId: r.collectionId,
      kind: r.kind,
      title: r.title,
      description: r.description,
      url: r.url,
      fileName: r.fileName,
      createdById: r.createdById,
      downloadCount: r.downloadCount,
      createdAt: r.createdAt,
    };
  }
}
