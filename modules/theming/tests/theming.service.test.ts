import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  MAX_CUSTOM_CSS_BYTES,
  MAX_FOOTER_HTML_BYTES,
  MAX_LOGO_BYTES,
} from '../src/dto.js';
import {
  CustomCssTooLargeError,
  CustomCssUnsafeError,
  EmptyLogoError,
  FooterHtmlTooLargeError,
  InvalidHueError,
  InvalidSaturationError,
  LogoTooLargeError,
  UnsupportedFontError,
  UnsupportedLogoTypeError,
} from '../src/errors.js';
import { ThemingService } from '../src/theming.service.js';

interface ThemeRow {
  tenantId: string;
  logoUrl: string | null;
  logoStorageKey: string | null;
  logoMimeType: string | null;
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
          logoStorageKey: null,
          logoMimeType: null,
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

/**
 * Storage fake en memoria: registra uploads/deletes para aserciones del test
 * del uploader de logo. `upload` devuelve `{ key }` igual que LocalDiskStorage
 * y S3Storage del host.
 */
function makeFakeStorage() {
  const blobs = new Map<string, { buffer: Buffer; contentType?: string }>();
  const calls = { upload: 0, delete: 0, download: 0 };
  return {
    blobs,
    calls,
    async upload(key: string, data: Buffer, contentType?: string) {
      calls.upload++;
      blobs.set(key, { buffer: Buffer.from(data), contentType });
      return { key };
    },
    async download(key: string) {
      calls.download++;
      const b = blobs.get(key);
      if (!b) throw new Error('not found');
      return b.buffer;
    },
    async delete(key: string) {
      calls.delete++;
      blobs.delete(key);
    },
    async getSignedUrl(key: string) {
      return `/storage/${key}`;
    },
  };
}

function makeFakeCtx(storage?: ReturnType<typeof makeFakeStorage>) {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    storage: storage ?? makeFakeStorage(),
    eventBus: { publish: async () => {} },
  } as never;
}

const fakeCtx = makeFakeCtx();

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

describe('ThemingService.uploadLogo', () => {
  // PNG 1x1 transparente válido en base64 (mismo asset que el e2e).
  const tinyPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('sube el blob al storage y setea logoUrl al endpoint público + storageKey estable', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const service = new ThemingService(prisma as never, makeFakeCtx(storage));

    const snap = await service.uploadLogo(tenant, {
      data: tinyPngBase64,
      filename: 'logo.png',
      contentType: 'image/png',
    });

    expect(snap.logoUploaded).toBe(true);
    expect(snap.logoUrl).toMatch(/^\/api\/v1\/modules\/theming\/tenants\/[\w-]+\/logo\?v=\d+$/);
    expect(storage.calls.upload).toBe(1);
    expect(storage.blobs.has(`tenants/${tenant}/branding/logo`)).toBe(true);
  });

  it('rechaza un contentType no permitido con UnsupportedLogoTypeError', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, makeFakeCtx());
    await expect(
      service.uploadLogo(tenant, {
        data: tinyPngBase64,
        filename: 'logo.gif',
        contentType: 'image/gif',
      }),
    ).rejects.toBeInstanceOf(UnsupportedLogoTypeError);
  });

  it('rechaza un logo que excede MAX_LOGO_BYTES con LogoTooLargeError', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const service = new ThemingService(prisma as never, makeFakeCtx(storage));
    // Buffer de MAX_LOGO_BYTES + 1 byte → base64.
    const oversized = Buffer.alloc(MAX_LOGO_BYTES + 1, 0).toString('base64');
    await expect(
      service.uploadLogo(tenant, {
        data: oversized,
        filename: 'huge.png',
        contentType: 'image/png',
      }),
    ).rejects.toBeInstanceOf(LogoTooLargeError);
    // No debe haber tocado el storage.
    expect(storage.calls.upload).toBe(0);
  });

  it('rechaza data vacía con EmptyLogoError', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, makeFakeCtx());
    await expect(
      service.uploadLogo(tenant, {
        // base64 que decodifica a 0 bytes.
        data: '====',
        filename: 'empty.png',
        contentType: 'image/png',
      }),
    ).rejects.toBeInstanceOf(EmptyLogoError);
  });

  it('es idempotente — re-subir reemplaza el blob anterior (delete + upload)', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const service = new ThemingService(prisma as never, makeFakeCtx(storage));

    await service.uploadLogo(tenant, {
      data: tinyPngBase64,
      filename: 'logo.png',
      contentType: 'image/png',
    });
    const second = await service.uploadLogo(tenant, {
      data: tinyPngBase64,
      filename: 'logo2.webp',
      contentType: 'image/webp',
    });

    expect(second.logoUploaded).toBe(true);
    // Misma key estable → un solo blob, sin huérfanos.
    expect(storage.blobs.size).toBe(1);
    // El segundo upload borró el anterior antes de escribir.
    expect(storage.calls.delete).toBe(1);
    expect(storage.calls.upload).toBe(2);
  });

  it('getLogoBlob devuelve el blob con el mimeType persistido', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const service = new ThemingService(prisma as never, makeFakeCtx(storage));

    await service.uploadLogo(tenant, {
      data: tinyPngBase64,
      filename: 'logo.png',
      contentType: 'image/png',
    });
    const { buffer, mimeType } = await service.getLogoBlob(tenant);
    expect(mimeType).toBe('image/png');
    expect(buffer.length).toBeGreaterThan(50);
  });

  it('removeLogo limpia blob + columnas y deja logoUploaded en false', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const service = new ThemingService(prisma as never, makeFakeCtx(storage));

    await service.uploadLogo(tenant, {
      data: tinyPngBase64,
      filename: 'logo.png',
      contentType: 'image/png',
    });
    const cleared = await service.removeLogo(tenant);
    expect(cleared.logoUploaded).toBe(false);
    expect(cleared.logoUrl).toBeNull();
    expect(storage.blobs.size).toBe(0);
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
