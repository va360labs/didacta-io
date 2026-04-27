import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CertificatesService } from '../src/certificates.service';

interface TemplateRow {
  id: string;
  tenantId: string;
  name: string;
  body: string;
  primaryColor: string;
  logoUrl: string | null;
  signerName: string | null;
  signerTitle: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface CourseRow {
  id: string;
  tenantId: string;
  certificateTemplateId: string | null;
}

let nextId = 1;
function uid() {
  return `tpl-${nextId++}`;
}

function setup(initialTemplates: Partial<TemplateRow>[] = [], courses: CourseRow[] = []) {
  nextId = 1;
  const templates: TemplateRow[] = initialTemplates.map((t) => ({
    id: t.id ?? uid(),
    tenantId: t.tenantId ?? 't1',
    name: t.name ?? 'tpl',
    body: t.body ?? 'body',
    primaryColor: t.primaryColor ?? '#0f172a',
    logoUrl: t.logoUrl ?? null,
    signerName: t.signerName ?? null,
    signerTitle: t.signerTitle ?? null,
    isDefault: t.isDefault ?? false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  const tx = {
    modCertificatesTemplate: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        let n = 0;
        for (const t of templates) {
          const matchesTenant = t.tenantId === where.tenantId;
          const matchesDefault = where.isDefault === undefined || t.isDefault === where.isDefault;
          const matchesNot =
            !where.id || (where.id.not ? t.id !== where.id.not : t.id === where.id);
          if (matchesTenant && matchesDefault && matchesNot) {
            Object.assign(t, data);
            n++;
          }
        }
        return { count: n };
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          ...data,
          id: uid(),
          createdAt: new Date(),
          updatedAt: new Date(),
        } as TemplateRow;
        templates.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const t = templates.find((tt) => tt.id === where.id);
        if (!t) throw new Error(`template ${where.id} not found`);
        Object.assign(t, data);
        t.updatedAt = new Date();
        return t;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const idx = templates.findIndex((t) => t.id === where.id);
        if (idx >= 0) templates.splice(idx, 1);
      }),
    },
  };

  const prisma = {
    modCertificatesTemplate: {
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        return templates
          .filter((t) => t.tenantId === where.tenantId)
          .sort((a, b) => {
            if (orderBy?.[0]?.isDefault === 'desc') {
              if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          });
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        return (
          templates.find((t) => {
            if (t.tenantId !== where.tenantId) return false;
            if (where.id && (where.id.not ? t.id === where.id.not : t.id !== where.id))
              return false;
            if (where.name && t.name !== where.name) return false;
            if (where.isDefault !== undefined && t.isDefault !== where.isDefault) return false;
            return true;
          }) ?? null
        );
      }),
      delete: vi.fn(async ({ where }: any) => {
        const idx = templates.findIndex((t) => t.id === where.id);
        if (idx >= 0) templates.splice(idx, 1);
      }),
    },
    modCoursesCourse: {
      count: vi.fn(async ({ where }: any) => {
        return courses.filter(
          (c) =>
            c.tenantId === where.tenantId &&
            c.certificateTemplateId === where.certificateTemplateId,
        ).length;
      }),
    },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };

  const ctx = {
    eventBus: { publish: vi.fn() },
    auditLog: { record: vi.fn() },
    storage: {},
    evidenceVault: {},
    notificationHub: {},
    i18n: { t: (k: string) => k },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({}) },
    config: {},
    hookRegistry: { register: vi.fn(), run: vi.fn() },
  } as never;

  const service = new CertificatesService(prisma as never, ctx);
  return { service, prisma, tx, templates, courses };
}

describe('CertificatesService.createTemplate', () => {
  it('crea con isDefault=false y los campos default', async () => {
    const { service, templates } = setup();
    const t = await service.createTemplate('t1', { name: 'A', body: 'b' });
    expect(t.name).toBe('A');
    expect(t.primaryColor).toBe('#0f172a');
    expect(t.isDefault).toBe(false);
    expect(templates).toHaveLength(1);
  });

  it('crea con isDefault=true y desmarca otras default', async () => {
    const ctx = setup([{ id: 'tpl-old', name: 'Vieja', isDefault: true }]);
    await ctx.service.createTemplate('t1', { name: 'Nueva', body: 'b', isDefault: true });
    expect(ctx.templates.find((t) => t.id === 'tpl-old')?.isDefault).toBe(false);
    expect(ctx.templates.find((t) => t.name === 'Nueva')?.isDefault).toBe(true);
  });

  it('rechaza nombre duplicado en el mismo tenant', async () => {
    const ctx = setup([{ name: 'A' }]);
    await expect(ctx.service.createTemplate('t1', { name: 'A', body: 'x' })).rejects.toMatchObject({
      code: 'TEMPLATE_NAME_TAKEN',
    });
  });
});

describe('CertificatesService.updateTemplate', () => {
  it('actualiza solo los campos presentes', async () => {
    const ctx = setup([{ name: 'A', body: 'old', primaryColor: '#000000' }]);
    const t = ctx.templates[0]!;
    await ctx.service.updateTemplate('t1', t.id, { body: 'new' });
    expect(t.body).toBe('new');
    expect(t.primaryColor).toBe('#000000');
  });

  it('lanza TEMPLATE_NOT_FOUND si el id no pertenece al tenant', async () => {
    const ctx = setup([{ tenantId: 'other' }]);
    const t = ctx.templates[0]!;
    await expect(ctx.service.updateTemplate('t1', t.id, { body: 'x' })).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
  });

  it('rechaza rename a nombre ya tomado por otra plantilla', async () => {
    const ctx = setup([{ name: 'A' }, { name: 'B' }]);
    const tplB = ctx.templates.find((t) => t.name === 'B')!;
    await expect(ctx.service.updateTemplate('t1', tplB.id, { name: 'A' })).rejects.toMatchObject({
      code: 'TEMPLATE_NAME_TAKEN',
    });
  });

  it('al marcar isDefault=true desmarca la previa default', async () => {
    const ctx = setup([
      { id: 'tpl-old', name: 'Old', isDefault: true },
      { id: 'tpl-new', name: 'New', isDefault: false },
    ]);
    await ctx.service.updateTemplate('t1', 'tpl-new', { isDefault: true });
    expect(ctx.templates.find((t) => t.id === 'tpl-old')?.isDefault).toBe(false);
    expect(ctx.templates.find((t) => t.id === 'tpl-new')?.isDefault).toBe(true);
  });
});

describe('CertificatesService.setDefaultTemplate', () => {
  it('marca como default y desmarca la previa', async () => {
    const ctx = setup([
      { id: 'tpl-a', name: 'A', isDefault: true },
      { id: 'tpl-b', name: 'B', isDefault: false },
    ]);
    await ctx.service.setDefaultTemplate('t1', 'tpl-b');
    expect(ctx.templates.find((t) => t.id === 'tpl-a')?.isDefault).toBe(false);
    expect(ctx.templates.find((t) => t.id === 'tpl-b')?.isDefault).toBe(true);
  });
});

describe('CertificatesService.deleteTemplate', () => {
  it('elimina cuando no es default ni está en uso', async () => {
    const ctx = setup([{ id: 'tpl-a', name: 'A' }]);
    await ctx.service.deleteTemplate('t1', 'tpl-a');
    expect(ctx.templates).toHaveLength(0);
  });

  it('rechaza si es la default', async () => {
    const ctx = setup([{ id: 'tpl-a', name: 'A', isDefault: true }]);
    await expect(ctx.service.deleteTemplate('t1', 'tpl-a')).rejects.toMatchObject({
      code: 'TEMPLATE_IS_DEFAULT',
    });
  });

  it('rechaza si algún curso la tiene asignada', async () => {
    const ctx = setup(
      [{ id: 'tpl-a', name: 'A' }],
      [{ id: 'c1', tenantId: 't1', certificateTemplateId: 'tpl-a' }],
    );
    await expect(ctx.service.deleteTemplate('t1', 'tpl-a')).rejects.toMatchObject({
      code: 'TEMPLATE_IN_USE',
      courseCount: 1,
    });
  });
});

describe('CertificatesService.getEffectiveTemplate', () => {
  it('devuelve la del curso si tiene templateId asignado', async () => {
    const ctx = setup([
      { id: 'tpl-default', name: 'Def', isDefault: true },
      { id: 'tpl-course', name: 'Curso' },
    ]);
    const t = await ctx.service.getEffectiveTemplate('t1', 'tpl-course');
    expect(t?.id).toBe('tpl-course');
  });

  it('cae a la default del tenant si el curso no tiene asignada', async () => {
    const ctx = setup([
      { id: 'tpl-default', name: 'Def', isDefault: true },
      { id: 'tpl-other', name: 'Otra' },
    ]);
    const t = await ctx.service.getEffectiveTemplate('t1', null);
    expect(t?.id).toBe('tpl-default');
  });

  it('cae a default si el courseTemplateId apunta a una plantilla inexistente', async () => {
    const ctx = setup([{ id: 'tpl-default', name: 'Def', isDefault: true }]);
    const t = await ctx.service.getEffectiveTemplate('t1', 'tpl-zombie');
    expect(t?.id).toBe('tpl-default');
  });

  it('devuelve null si no hay default ni asignación', async () => {
    const ctx = setup([]);
    const t = await ctx.service.getEffectiveTemplate('t1', null);
    expect(t).toBeNull();
  });
});
