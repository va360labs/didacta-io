import { beforeEach, describe, expect, it } from 'vitest';
import { ResourcesService, type ResourcesEventPublisher } from '../src/resources.service.js';
import { ResourcesNotFoundError, ResourcesValidationError } from '../src/errors.js';

// ============================================================================
// Tests del dominio mod.resources con un MockPrisma in-memory (sin BD ni red),
// mismo patrón que surveys.service.test.ts. Cubren: validación de alta (título,
// descripción, URL por tipo), buscador y filtro por categoría, contador de
// descargas, edición y borrado con aislamiento por tenant.
// ============================================================================

interface Row {
  [key: string]: unknown;
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

class MockPrisma {
  resources: Row[] = [];

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
          if (w['category'] !== undefined && r['category'] !== w['category']) return false;
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
        const d = data as Row;
        const inc = (d['downloadCount'] as Row | undefined)?.['increment'] as number | undefined;
        if (inc) m['downloadCount'] = (m['downloadCount'] as number) + inc;
      }
      return { count: matched.length };
    },
    update: async ({ where, data }: never) => {
      const w = where as Row;
      const row = this.resources.find((r) => r['id'] === w['id']);
      if (!row) throw new Error('not found');
      Object.assign(row, data as Row);
      return { ...row };
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

function baseInput() {
  return {
    tenantId: TENANT,
    createdById: 'staff-1',
    category: 'WORKFLOW' as const,
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

  it('crea un recurso FILE válido y emite resources.resource.created', async () => {
    const { service, published } = makeService(mock);
    const view = await service.create(baseInput());
    expect(view.title).toBe('Workflow de captación en n8n');
    expect(view.downloadCount).toBe(0);
    expect(published[0]!.name).toBe('resources.resource.created');
    expect(published[0]!.actorId).toBe('staff-1');
  });

  it('valida título, descripción y URL según el tipo', async () => {
    const { service } = makeService(mock);

    await expect(service.create({ ...baseInput(), title: 'ab' })).rejects.toBeInstanceOf(
      ResourcesValidationError,
    );
    await expect(
      service.create({ ...baseInput(), description: 'x'.repeat(1001) }),
    ).rejects.toBeInstanceOf(ResourcesValidationError);

    // LINK exige http(s) absoluto; una ruta local no vale.
    await expect(
      service.create({ ...baseInput(), kind: 'LINK', url: '/api/v1/storage/file/x' }),
    ).rejects.toBeInstanceOf(ResourcesValidationError);
    await expect(
      service.create({ ...baseInput(), kind: 'LINK', url: 'ftp://tools.example' }),
    ).rejects.toBeInstanceOf(ResourcesValidationError);

    // FILE admite ruta del storage local; LINK https válido pasa.
    await expect(service.create(baseInput())).resolves.toBeTruthy();
    await expect(
      service.create({ ...baseInput(), kind: 'LINK', url: 'https://claude.ai' }),
    ).resolves.toBeTruthy();
  });

  it('lista con filtro de categoría y buscador insensible a mayúsculas', async () => {
    const { service } = makeService(mock);
    await service.create(baseInput());
    await service.create({
      ...baseInput(),
      category: 'TOOL',
      kind: 'LINK',
      title: 'Perplexity para investigación',
      description: 'Buscador con fuentes',
      url: 'https://perplexity.ai',
    });

    expect(await service.list(TENANT)).toHaveLength(2);
    expect(await service.list(TENANT, { category: 'TOOL' })).toHaveLength(1);
    expect((await service.list(TENANT, { q: 'CAPTACIÓN' }))[0]!.title).toContain('captación');
    expect(await service.list(TENANT, { q: 'fuentes' })).toHaveLength(1);
    expect(await service.list(TENANT, { q: 'no-existe' })).toHaveLength(0);
    expect(await service.list('otro-tenant')).toHaveLength(0);
  });

  it('registerDownload incrementa el contador y devuelve la URL', async () => {
    const { service } = makeService(mock);
    const view = await service.create(baseInput());
    const first = await service.registerDownload(TENANT, view.id);
    expect(first.url).toBe(baseInput().url);
    await service.registerDownload(TENANT, view.id);
    expect((await service.list(TENANT))[0]!.downloadCount).toBe(2);

    await expect(service.registerDownload(TENANT, 'no-existe')).rejects.toBeInstanceOf(
      ResourcesNotFoundError,
    );
    await expect(service.registerDownload('otro-tenant', view.id)).rejects.toBeInstanceOf(
      ResourcesNotFoundError,
    );
  });

  it('update edita título/categoría y remove borra emitiendo el evento', async () => {
    const { service, published } = makeService(mock);
    const view = await service.create(baseInput());

    const updated = await service.update(TENANT, view.id, {
      title: 'Workflow de captación (v2)',
      category: 'TEMPLATE',
    });
    expect(updated.title).toBe('Workflow de captación (v2)');
    expect(updated.category).toBe('TEMPLATE');
    await expect(service.update(TENANT, view.id, { title: 'ab' })).rejects.toBeInstanceOf(
      ResourcesValidationError,
    );
    await expect(service.update('otro-tenant', view.id, {})).rejects.toBeInstanceOf(
      ResourcesNotFoundError,
    );

    await service.remove(TENANT, view.id, 'staff-1');
    expect(await service.list(TENANT)).toHaveLength(0);
    expect(published.at(-1)!.name).toBe('resources.resource.deleted');
    await expect(service.remove(TENANT, view.id, 'staff-1')).rejects.toBeInstanceOf(
      ResourcesNotFoundError,
    );
  });
});
