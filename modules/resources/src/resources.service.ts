import type { PrismaClient } from '@didacta/database';
import { ResourcesNotFoundError, ResourcesValidationError } from './errors.js';

/**
 * mod.resources — dominio puro (sin NestJS). Biblioteca de recursos del tenant:
 * workflows de las clases, skills, directorio de herramientas y plantillas.
 * Categorías FIJAS (enum) a propósito — doc/mejoras.md bloque 4: "categorías
 * fijas, buscador"; un taxón libre acaba en un canal donde todo se pierde.
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
} as const;

export type ResourceCategoryValue = 'WORKFLOW' | 'SKILL' | 'TOOL' | 'TEMPLATE' | 'OTHER';
export type ResourceKindValue = 'FILE' | 'LINK';

export const RESOURCE_CATEGORIES: readonly ResourceCategoryValue[] = [
  'WORKFLOW',
  'SKILL',
  'TOOL',
  'TEMPLATE',
  'OTHER',
];

const TITLE_MIN = 3;
const TITLE_MAX = 160;
const DESCRIPTION_MAX = 1000;
const LIST_LIMIT = 200;

export interface CreateResourceInput {
  tenantId: string;
  createdById: string;
  category: ResourceCategoryValue;
  kind: ResourceKindValue;
  title: string;
  description?: string | null;
  url: string;
  fileName?: string | null;
  zoomSessionId?: string | null;
}

export interface ResourceView {
  id: string;
  category: string;
  kind: string;
  title: string;
  description: string | null;
  url: string;
  fileName: string | null;
  downloadCount: number;
  createdAt: Date;
}

/**
 * LINK debe ser http(s) absoluto; FILE admite además rutas del propio storage
 * (`/api/v1/storage/file/...` cuando el driver es disco local).
 */
function validateUrl(kind: ResourceKindValue, raw: string): string {
  const url = raw.trim();
  if (kind === 'FILE' && url.startsWith('/')) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ResourcesValidationError('La URL del recurso no es válida.');
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

  async create(input: CreateResourceInput): Promise<ResourceView> {
    const title = input.title.trim();
    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      throw new ResourcesValidationError(
        `El título debe tener entre ${TITLE_MIN} y ${TITLE_MAX} caracteres.`,
      );
    }
    const description = input.description?.trim() || null;
    if (description && description.length > DESCRIPTION_MAX) {
      throw new ResourcesValidationError(
        `La descripción no puede superar ${DESCRIPTION_MAX} caracteres.`,
      );
    }
    const url = validateUrl(input.kind, input.url);

    const resource = await this.prisma.modResourcesResource.create({
      data: {
        tenantId: input.tenantId,
        category: input.category,
        kind: input.kind,
        title,
        description,
        url,
        fileName: input.kind === 'FILE' ? (input.fileName?.trim() ?? null) : null,
        zoomSessionId: input.zoomSessionId ?? null,
        createdById: input.createdById,
      },
    });

    await this.publisher.publish(input.tenantId, input.createdById, RESOURCES_EVENT.CREATED, {
      resourceId: resource.id,
      category: resource.category,
      kind: resource.kind,
    });

    return this.toView(resource);
  }

  /** Listado con buscador (título + descripción, sin distinguir mayúsculas). */
  async list(
    tenantId: string,
    filter: { category?: ResourceCategoryValue; q?: string } = {},
  ): Promise<ResourceView[]> {
    const q = filter.q?.trim();
    const resources = await this.prisma.modResourcesResource.findMany({
      where: {
        tenantId,
        ...(filter.category ? { category: filter.category } : {}),
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
    return resources.map((r) => this.toView(r));
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

  async update(
    tenantId: string,
    resourceId: string,
    patch: { title?: string; description?: string | null; category?: ResourceCategoryValue },
  ): Promise<ResourceView> {
    const existing = await this.prisma.modResourcesResource.findFirst({
      where: { id: resourceId, tenantId },
    });
    if (!existing) throw new ResourcesNotFoundError();

    const title = patch.title?.trim();
    if (title !== undefined && (title.length < TITLE_MIN || title.length > TITLE_MAX)) {
      throw new ResourcesValidationError(
        `El título debe tener entre ${TITLE_MIN} y ${TITLE_MAX} caracteres.`,
      );
    }
    const description =
      patch.description === undefined ? undefined : (patch.description?.trim() ?? null);
    if (description && description.length > DESCRIPTION_MAX) {
      throw new ResourcesValidationError(
        `La descripción no puede superar ${DESCRIPTION_MAX} caracteres.`,
      );
    }

    const updated = await this.prisma.modResourcesResource.update({
      where: { id: resourceId },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(patch.category ? { category: patch.category } : {}),
      },
    });
    return this.toView(updated);
  }

  async remove(tenantId: string, resourceId: string, actorId: string): Promise<void> {
    const { count } = await this.prisma.modResourcesResource.deleteMany({
      where: { id: resourceId, tenantId },
    });
    if (count === 0) throw new ResourcesNotFoundError();
    await this.publisher.publish(tenantId, actorId, RESOURCES_EVENT.DELETED, { resourceId });
  }

  private toView(r: {
    id: string;
    category: string;
    kind: string;
    title: string;
    description: string | null;
    url: string;
    fileName: string | null;
    downloadCount: number;
    createdAt: Date;
  }): ResourceView {
    return {
      id: r.id,
      category: r.category,
      kind: r.kind,
      title: r.title,
      description: r.description,
      url: r.url,
      fileName: r.fileName,
      downloadCount: r.downloadCount,
      createdAt: r.createdAt,
    };
  }
}
