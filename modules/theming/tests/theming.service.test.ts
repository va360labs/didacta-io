import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, MAX_CUSTOM_CSS_BYTES, MAX_FOOTER_HTML_BYTES } from '../src/dto.js';
import {
  CustomCssTooLargeError,
  CustomCssUnsafeError,
  FooterHtmlTooLargeError,
  InvalidHueError,
  InvalidSaturationError,
  UnsupportedFontError,
} from '../src/errors.js';
import { ThemingService } from '../src/theming.service.js';

interface ThemeRow {
  tenantId: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  brandHue: number;
  brandSaturation: number;
  displayFontFamily: string;
  bodyFontFamily: string;
  customCss: string | null;
  footerHtml: string | null;
  updatedAt: Date;
}

function makeFakePrisma() {
  let row: ThemeRow | null = null;

  return {
    modThemingTenantTheme: {
      async findUnique(args: { where: { tenantId: string } }): Promise<ThemeRow | null> {
        if (!row || row.tenantId !== args.where.tenantId) return null;
        return row;
      },
      async create(args: { data: Partial<ThemeRow> & { tenantId: string } }): Promise<ThemeRow> {
        row = {
          tenantId: args.data.tenantId,
          logoUrl: null,
          faviconUrl: null,
          brandHue: args.data.brandHue ?? DEFAULT_THEME.brandHue,
          brandSaturation: args.data.brandSaturation ?? DEFAULT_THEME.brandSaturation,
          displayFontFamily: args.data.displayFontFamily ?? DEFAULT_THEME.displayFontFamily,
          bodyFontFamily: args.data.bodyFontFamily ?? DEFAULT_THEME.bodyFontFamily,
          customCss: null,
          footerHtml: null,
          updatedAt: new Date(),
        };
        return row;
      },
      async update(args: {
        where: { tenantId: string };
        data: Partial<ThemeRow>;
      }): Promise<ThemeRow> {
        if (!row || row.tenantId !== args.where.tenantId) {
          throw new Error('Row not found in fake prisma');
        }
        row = {
          ...row,
          ...args.data,
          updatedAt: new Date(),
        };
        return row;
      },
    },
  };
}

const fakeCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
} as never;

const tenant = '11111111-1111-1111-1111-111111111111';

describe('ThemingService.getOrCreate', () => {
  it('crea un theme con defaults Didacta cuando no existe', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    const theme = await service.getOrCreate(tenant);

    expect(theme.tenantId).toBe(tenant);
    expect(theme.brandHue).toBe(DEFAULT_THEME.brandHue);
    expect(theme.brandSaturation).toBe(DEFAULT_THEME.brandSaturation);
    expect(theme.displayFontFamily).toBe(DEFAULT_THEME.displayFontFamily);
    expect(theme.bodyFontFamily).toBe(DEFAULT_THEME.bodyFontFamily);
    expect(theme.logoUrl).toBeNull();
    expect(theme.faviconUrl).toBeNull();
    expect(theme.customCss).toBeNull();
  });

  it('es idempotente — no duplica si ya existe', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    const a = await service.getOrCreate(tenant);
    const b = await service.getOrCreate(tenant);
    expect(a.tenantId).toBe(b.tenantId);
    expect(a.brandHue).toBe(b.brandHue);
  });
});

describe('ThemingService.update', () => {
  it('actualiza solo los campos provistos', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await service.getOrCreate(tenant);
    const updated = await service.update(tenant, { brandHue: 24 });
    expect(updated.brandHue).toBe(24);
    // Otros campos quedan en defaults.
    expect(updated.displayFontFamily).toBe(DEFAULT_THEME.displayFontFamily);
  });

  it('crea el theme si no existe antes de actualizar', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    const updated = await service.update(tenant, { brandHue: 180, brandSaturation: 50 });
    expect(updated.brandHue).toBe(180);
    expect(updated.brandSaturation).toBe(50);
  });

  it('rechaza brandHue fuera de [0,360]', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await expect(service.update(tenant, { brandHue: 400 })).rejects.toBeInstanceOf(InvalidHueError);
    await expect(service.update(tenant, { brandHue: -1 })).rejects.toBeInstanceOf(InvalidHueError);
  });

  it('rechaza brandSaturation fuera de [0,100]', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await expect(service.update(tenant, { brandSaturation: 150 })).rejects.toBeInstanceOf(
      InvalidSaturationError,
    );
  });

  it('rechaza fuente fuera de la whitelist', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await expect(
      service.update(tenant, { displayFontFamily: 'Comic Sans' as never }),
    ).rejects.toBeInstanceOf(UnsupportedFontError);
  });

  it('rechaza customCss demasiado grande', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    const oversized = 'a'.repeat(MAX_CUSTOM_CSS_BYTES + 1);
    await expect(service.update(tenant, { customCss: oversized })).rejects.toBeInstanceOf(
      CustomCssTooLargeError,
    );
  });

  it('rechaza @import en customCss', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await expect(
      service.update(tenant, { customCss: "@import url('https://evil.com/x.css');" }),
    ).rejects.toBeInstanceOf(CustomCssUnsafeError);
  });

  it('rechaza expression() en customCss', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await expect(
      service.update(tenant, { customCss: 'body { width: expression(alert(1)); }' }),
    ).rejects.toBeInstanceOf(CustomCssUnsafeError);
  });

  it('rechaza javascript: en url() del customCss', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await expect(
      service.update(tenant, { customCss: ".bg { background: url('javascript:alert(1)'); }" }),
    ).rejects.toBeInstanceOf(CustomCssUnsafeError);
  });

  it('rechaza intento de cerrar </style> en customCss', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await expect(
      service.update(tenant, { customCss: 'body{}</style><script>x</script>' }),
    ).rejects.toBeInstanceOf(CustomCssUnsafeError);
  });

  it('rechaza footerHtml demasiado grande', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    const oversized = 'a'.repeat(MAX_FOOTER_HTML_BYTES + 1);
    await expect(service.update(tenant, { footerHtml: oversized })).rejects.toBeInstanceOf(
      FooterHtmlTooLargeError,
    );
  });

  it('permite null para limpiar campos opcionales', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await service.update(tenant, { customCss: 'body { color: red; }' });
    const cleared = await service.update(tenant, { customCss: null });
    expect(cleared.customCss).toBeNull();
  });

  it('actualiza display y body fonts juntos sin error', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    const updated = await service.update(tenant, {
      displayFontFamily: 'Manrope',
      bodyFontFamily: 'DM Sans',
    });
    expect(updated.displayFontFamily).toBe('Manrope');
    expect(updated.bodyFontFamily).toBe('DM Sans');
  });
});

describe('ThemingService.reset', () => {
  it('vuelve a defaults conservando el registro', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await service.update(tenant, {
      brandHue: 24,
      brandSaturation: 90,
      displayFontFamily: 'Manrope',
      logoUrl: 'https://cdn.example.com/logo.png',
      customCss: 'body { color: red; }',
    });
    const reset = await service.reset(tenant);
    expect(reset.brandHue).toBe(DEFAULT_THEME.brandHue);
    expect(reset.brandSaturation).toBe(DEFAULT_THEME.brandSaturation);
    expect(reset.displayFontFamily).toBe(DEFAULT_THEME.displayFontFamily);
    expect(reset.logoUrl).toBeNull();
    expect(reset.customCss).toBeNull();
  });
});
