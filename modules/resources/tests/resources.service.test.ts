import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_COLLECTIONS,
  ResourcesService,
  type ResourcesEventPublisher,
} from '../src/resources.service.js';
import {
  ResourcesForbiddenError,
  ResourcesNotFoundError,
  ResourcesValidationError,
} from '../src/errors.js';

// ============================================================================
// Tests del dominio mod.resources con un MockPrisma in-memory (sin BD ni red).
// Cubren: siembra perezosa de las 6 colecciones default, CRUD de colecciones
// (unique por título, borrado solo si vacía), compartir recursos (validación
// de URL por tipo, colección del tenant), buscador, contador de descargas y
// borrado autor-o-staff.
// ============================================================================

interface Row {
  [key: string]: unknown;
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function uniqueViolation(): Error & { code: string } {
  const err = new Error('Unique constraint failed') as Error & { code: string };
  err.code = 'P2002';
  return err;
}

class MockPrisma {
  collections: Row[] = [];
  resources: Row[] = [];

  private countFor(collectionId: unknown): number {
    return this.resources.filter((r) => r['collectionId'] === collectionId).length;
  }

  private withCount(c: Row, include?: Row): Row {
    const out: Row = { ...c };
    if (include?.['_count']) out['_count'] = { resources: this.countFor(c['id']) };
    return out;
  }

  modResourcesCollection = {
    create: async ({ data }: never) => {
      const d = data as Row;
      if (
        this.collections.some((c) => c['tenantId'] === d['tenantId'] && c['title'] === d['title'])
      ) {
        throw uniqueViolation();
      }
      const row: Row = {
        id: nextId('col'),
        description: null,
        coverUrl: null,
        sortOrder: 0,
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...d,
      };
      this.collections.push(row);
      return { ...row };
    },
    findFirst: async ({ where, include }: never) => {
      const w = where as Row;
      const c = this.collections.find(
        (x) => x['id'] === w['id'] && x['tenantId'] === w['tenantId'],
      );
      return c ? this.withCount(c, include as Row | undefined) : null;
    },
    findMany: async ({ where, include }: never) => {
      const w = where as Row;
      return this.collections
        .filter((c) => c['tenantId'] === w['tenantId'])
        .sort((a, b) => (a['sortOrder'] as number) - (b['sortOrder'] as number))
        .map((c) => this.withCount(c, include as Row | undefined));
    },
    update: async ({ where, data }: never) => {
      const w = where as Row;
      const row = this.collections.find((c) => c['id'] === w['id']);
      if (!row) throw new Error('not found');
      const d = data as Row;
      if (
        d['title'] !== undefined &&
        this.collections.some(
          (c) =>
            c['id'] !== row['id'] && c['tenantId'] === row['tenantId'] && c['title'] === d['title'],
        )
      ) {
        throw uniqueViolation();
      }
      Object.assign(row, d);
      return { ...row };
    },
    deleteMany: async ({ where }: never) => {
      const w = where as Row;
      const before = this.collections.length;
      this.collections = this.collections.filter(
        (c) => !(c['id'] === w['id'] && c['tenantId'] === w['tenantId']),
      );
      return { count: before - this.collections.length };
    },
  };

  modResourcesResource = {
    create: async ({ data }: never) => {
      const row: Row = {
        id: nextId('res'),
        description: null,
        fileName: null,
        zoomSessionId: null,
        downloadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(data as Row),
      };
      this.resources.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: never) => {
      const w = where as Row;
      return (
        this.resources.find((r) => r['id'] === w['id'] && r['tenantId'] === w['tenantId']) ?? null
      );
    },
    findMany: async ({ where }: never) => {
      const w = where as Row;
      return this.resources
        .filter((r) => {
          if (r['tenantId'] !== w['tenantId']) return false;
          if (w['collectionId'] !== undefined && r['collectionId'] !== w['collectionId'])
            return false;
          const or = w['OR'] as Array<Row> | undefined;
          if (or) {
            const q = ((or[0]!['title'] as Row)['contains'] as string).toLowerCase();
            const title = (r['title'] as string).toLowerCase();
            const desc = ((r['description'] as string | null) ?? '').toLowerCase();
            if (!title.includes(q) && !desc.includes(q)) return false;
          }
          return true;
        })
        .sort((a, b) => (b['createdAt'] as Date).getTime() - (a['createdAt'] as Date).getTime());
    },
    updateMany: async ({ where, data }: never) => {
      const w = where as Row;
      const matched = this.resources.filter(
        (r) => r['id'] === w['id'] && r['tenantId'] === w['tenantId'],
      );
      for (const m of matched) {
        const inc = ((data as Row)['downloadCount'] as Row | undefined)?.['increment'] as
          | number
          | undefined;
        if (inc) m['downloadCount'] = (m['downloadCount'] as number) + inc;
      }
      return { count: matched.length };
    },
    deleteMany: async ({ where }: never) => {
      const w = where as Row;
      const before = this.resources.length;
      this.resources = this.resources.filter(
        (r) => !(r['id'] === w['id'] && r['tenantId'] === w['tenantId']),
      );
      return { count: before - this.resources.length };
    },
  };
}

const TENANT = 'tenant-1';

function makeService(mock: MockPrisma) {
  const published: Array<{ tenantId: string; actorId: string | null; name: string; payload: Row }> =
    [];
  const publisher: ResourcesEventPublisher = {
    publish: async (tenantId, actorId, name, payload) => {
      published.push({ tenantId, actorId, name, payload });
    },
  };
  const service = new ResourcesService(mock as never, publisher);
  return { service, published };
}

async function seededCollectionId(service: ResourcesService): Promise<string> {
  const collections = await service.listCollections(TENANT);
  return collections[0]!.id;
}

function resourceInput(collectionId: string) {
  return {
    tenantId: TENANT,
    createdById: 'member-1',
    collectionId,
    kind: 'FILE' as const,
    title: 'Workflow de captación en n8n',
    description: 'El flujo montado en la clase del martes',
    url: '/api/v1/storage/file/tenants/t/uploads/flujo.json',
    fileName: 'flujo.json',
  };
}

describe('ResourcesService', () => {
  let mock: MockPrisma;

  beforeEach(() => {
    mock = new MockPrisma();
    idSeq = 0;
  });

  it('siembra las 6 colecciones default en el primer listado y no las duplica', async () => {
    const { service } = makeService(mock);
    const first = await service.listCollections(TENANT);
    expect(first).toHaveLength(DEFAULT_COLLECTIONS.length);
    expect(first[0]!.title).toBe('Workflows de clase');
    expect(first.every((c) => c.isDefault)).toBe(true);
    expect(first.every((c) => c.resourceCount === 0)).toBe(true);

    const second = await service.listCollections(TENANT);
    expect(second).toHaveLength(DEFAULT_COLLECTIONS.length);
    // Otro tenant siembra las suyas propias, aisladas.
    expect(await service.listCollections('tenant-2')).toHaveLength(DEFAULT_COLLECTIONS.length);
    expect(mock.collections).toHaveLength(DEFAULT_COLLECTIONS.length * 2);
  });

  it('crea colecciones (título único por tenant) y las coloca tras las default', async () => {
    const { service, published } = makeService(mock);
    await service.listCollections(TENANT);

    const created = await service.createCollection({
      tenantId: TENANT,
      createdById: 'staff-1',
      title: 'Guías de precios',
      description: 'Cómo presupuestar',
    });
    expect(created.resourceCount).toBe(0);
    expect(published.at(-1)!.name).toBe('resources.collection.created');

    await expect(
      service.createCollection({
        tenantId: TENANT,
        createdById: 'staff-1',
        title: 'Guías de precios',
      }),
    ).rejects.toBeInstanceOf(ResourcesValidationError);
    await expect(
      service.createCollection({ tenantId: TENANT, createdById: 'staff-1', title: 'ab' }),
    ).rejects.toBeInstanceOf(ResourcesValidationError);

    const all = await service.listCollections(TENANT);
    expect(all.at(-1)!.title).toBe('Guías de precios');
  });

  it('edita la portada y solo borra colecciones vacías', async () => {
    const { service } = makeService(mock);
    const collectionId = await seededCollectionId(service);

    const updated = await service.updateCollection(TENANT, collectionId, {
      coverUrl: '/api/v1/storage/file/tenants/t/uploads/portada.webp',
    });
    expect(updated.coverUrl).toContain('portada.webp');

    await service.create(resourceInput(collectionId));
    await expect(service.deleteCollection(TENANT, collectionId)).rejects.toBeInstanceOf(
      ResourcesValidationError,
    );

    const empty = await service.createCollection({
      tenantId: TENANT,
      createdById: 'staff-1',
      title: 'Temporal',
    });
    await service.deleteCollection(TENANT, empty.id);
    await expect(service.getCollection(TENANT, empty.id)).rejects.toBeInstanceOf(
      ResourcesNotFoundError,
    );
    await expect(service.updateCollection(TENANT, 'no-existe', {})).rejects.toBeInstanceOf(
      ResourcesNotFoundError,
    );
  });

  it('comparte recursos validando URL por tipo y colección del tenant', async () => {
    const { service, published } = makeService(mock);
    const collectionId = await seededCollectionId(service);

    const view = await service.create(resourceInput(collectionId));
    expect(view.createdById).toBe('member-1');
    expect(published.at(-1)!.name).toBe('resources.resource.created');

    await expect(
      service.create({ ...resourceInput(collectionId), kind: 'LINK', url: '/ruta/local' }),
    ).rejects.toBeInstanceOf(ResourcesValidationError);
    await expect(
      service.create({ ...resourceInput(collectionId), kind: 'LINK', url: 'ftp://x' }),
    ).rejects.toBeInstanceOf(ResourcesValidationError);
    // FILE local: SOLO el prefijo del storage — ni rutas de la app ni //host.
    await expect(
      service.create({ ...resourceInput(collectionId), url: '/admin/usuarios' }),
    ).rejects.toBeInstanceOf(ResourcesValidationError);
    await expect(
      service.create({ ...resourceInput(collectionId), url: '//evil.example/x.json' }),
    ).rejects.toBeInstanceOf(ResourcesValidationError);
    await expect(service.create({ ...resourceInput('col-ajena') })).rejects.toBeInstanceOf(
      ResourcesNotFoundError,
    );
    await expect(
      service.create({ ...resourceInput(collectionId), tenantId: 'tenant-2' }),
    ).rejects.toBeInstanceOf(ResourcesNotFoundError);
  });

  it('getCollection busca dentro de la colección sin mezclar otras', async () => {
    const { service } = makeService(mock);
    const collections = await service.listCollections(TENANT);
    const [a, b] = [collections[0]!.id, collections[1]!.id];

    await service.create(resourceInput(a));
    await service.create({
      ...resourceInput(b),
      kind: 'LINK',
      title: 'Perplexity para investigación',
      description: 'Buscador con fuentes',
      url: 'https://perplexity.ai',
    });

    const detailA = await service.getCollection(TENANT, a);
    expect(detailA.collection.resourceCount).toBe(1);
    expect(detailA.resources).toHaveLength(1);

    expect((await service.getCollection(TENANT, b, { q: 'FUENTES' })).resources).toHaveLength(1);
    expect((await service.getCollection(TENANT, b, { q: 'captación' })).resources).toHaveLength(0);
  });

  it('registerDownload incrementa y devuelve la URL', async () => {
    const { service } = makeService(mock);
    const collectionId = await seededCollectionId(service);
    const view = await service.create(resourceInput(collectionId));

    expect((await service.registerDownload(TENANT, view.id)).url).toBe(
      resourceInput(collectionId).url,
    );
    await service.registerDownload(TENANT, view.id);
    const detail = await service.getCollection(TENANT, collectionId);
    expect(detail.resources[0]!.downloadCount).toBe(2);

    await expect(service.registerDownload(TENANT, 'no-existe')).rejects.toBeInstanceOf(
      ResourcesNotFoundError,
    );
  });

  it('borra el autor lo suyo; otro miembro no; el staff todo', async () => {
    const { service, published } = makeService(mock);
    const collectionId = await seededCollectionId(service);
    const mine = await service.create(resourceInput(collectionId));
    const other = await service.create({ ...resourceInput(collectionId), title: 'Otro recurso' });

    await expect(
      service.remove(TENANT, mine.id, { id: 'member-2', isStaff: false }),
    ).rejects.toBeInstanceOf(ResourcesForbiddenError);

    await service.remove(TENANT, mine.id, { id: 'member-1', isStaff: false });
    expect(published.at(-1)!.name).toBe('resources.resource.deleted');

    await service.remove(TENANT, other.id, { id: 'admin-1', isStaff: true });
    expect((await service.getCollection(TENANT, collectionId)).resources).toHaveLength(0);

    await expect(
      service.remove(TENANT, mine.id, { id: 'member-1', isStaff: false }),
    ).rejects.toBeInstanceOf(ResourcesNotFoundError);
  });
});
