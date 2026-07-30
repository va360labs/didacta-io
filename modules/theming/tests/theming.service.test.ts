import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME,
  MAX_CUSTOM_CSS_BYTES,
  MAX_FOOTER_HTML_BYTES,
  MAX_LOGO_BYTES,
  MAX_SIGNIN_HEADLINE_CHARS,
  MAX_SIGNIN_SUBHEADLINE_CHARS,
} from '../src/dto.js';
import {
  CustomCssTooLargeError,
  CustomCssUnsafeError,
  EmptyLogoError,
  FooterHtmlTooLargeError,
  InvalidHueError,
  InvalidSaturationError,
  LogoTooLargeError,
  SigninCopyTooLongError,
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
  signinHeadline: string | null;
  signinSubheadline: string | null;
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
          signinHeadline: null,
          signinSubheadline: null,
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
 *
 * `uploadImage` simula el envoltorio del core (`withImageOptimization`): con
 * `recomprime: true` devuelve una key con extensión `.webp` y otro contentType,
 * que es lo que ocurre de verdad con un PNG grande. El módulo no puede importar
 * la implementación del host (vive en `apps/api`), así que aquí se reproduce el
 * CONTRATO: lo que importa es que el service persista lo DEVUELTO y no lo pedido.
 */
function makeFakeStorage(opts: { recomprime?: boolean } = {}) {
  const blobs = new Map<string, { buffer: Buffer; contentType?: string }>();
  const calls = { upload: 0, delete: 0, download: 0, uploadImage: 0 };
  const self = {
    blobs,
    calls,
    async upload(key: string, data: Buffer, contentType?: string) {
      calls.upload++;
      blobs.set(key, { buffer: Buffer.from(data), contentType });
      return { key };
    },
    async uploadImage(key: string, data: Buffer, contentType: string) {
      calls.uploadImage++;
      if (!opts.recomprime) {
        await self.upload(key, data, contentType);
        return {
          key,
          contentType,
          optimized: false,
          size: data.length,
          previousSize: data.length,
        };
      }
      const webpKey = `${key.replace(/\.[^./]+$/, '')}.webp`;
      const recomprimido = Buffer.from(data.subarray(0, Math.max(1, Math.floor(data.length / 2))));
      await self.upload(webpKey, recomprimido, 'image/webp');
      return {
        key: webpKey,
        contentType: 'image/webp',
        optimized: true,
        size: recomprimido.length,
        previousSize: data.length,
      };
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
  return self;
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
    expect(storage.calls.uploadImage).toBe(1);
    expect(storage.blobs.has(`tenants/${tenant}/branding/logo`)).toBe(true);
  });

  it('el logo pasa por uploadImage a 512px y en PNG (el mismo blob va en los emails)', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage();
    const spy = vi.spyOn(storage, 'uploadImage');
    const service = new ThemingService(prisma as never, makeFakeCtx(storage));

    await service.uploadLogo(tenant, {
      data: tinyPngBase64,
      filename: 'logo.png',
      contentType: 'image/png',
    });

    // `format: 'png'` es lo que impide que el logo acabe en WebP: hay clientes
    // de email que lo decodifican ignorando el alfa y pintan un rectángulo
    // negro donde debería estar la transparencia (regresión del 2026-07-30).
    expect(spy).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), 'image/png', {
      maxWidth: 512,
      format: 'png',
    });
    // Y NUNCA el `upload` crudo directamente: eso saltaría la optimización.
    expect(storage.calls.upload).toBe(1); // el único, hecho DESDE uploadImage
  });

  it('si el core recomprime, persiste la key y el MIME REALES (no los pedidos)', async () => {
    const prisma = makeFakePrisma();
    const storage = makeFakeStorage({ recomprime: true });
    const service = new ThemingService(prisma as never, makeFakeCtx(storage));

    await service.uploadLogo(tenant, {
      data: tinyPngBase64,
      filename: 'logo.png',
      contentType: 'image/png',
    });

    // El blob vive bajo la key con extensión nueva…
    expect(storage.blobs.has(`tenants/${tenant}/branding/logo.webp`)).toBe(true);
    // …y getLogoBlob lo encuentra, que es la prueba de que se persistió esa key
    // y no la pedida (si guardara la pedida, esto lanzaría 'not found').
    const { mimeType } = await service.getLogoBlob(tenant);
    expect(mimeType).toBe('image/webp');
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

  it('borra también el copy de la pantalla de acceso', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await service.update(tenant, {
      signinHeadline: 'Formación en IA aplicada.',
      signinSubheadline: 'Con la comunidad que la usa cada día.',
    });
    const reset = await service.reset(tenant);
    expect(reset.signinHeadline).toBeNull();
    expect(reset.signinSubheadline).toBeNull();
  });
});

describe('ThemingService — copy de la pantalla de acceso', () => {
  it('nace vacío: sin copy propio el web usa el texto genérico de Didacta', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    const theme = await service.getOrCreate(tenant);
    expect(theme.signinHeadline).toBeNull();
    expect(theme.signinSubheadline).toBeNull();
  });

  it('persiste titular y línea de apoyo', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    const updated = await service.update(tenant, {
      signinHeadline: 'Formación en IA aplicada, con la comunidad que la usa cada día.',
      signinSubheadline: 'Acceso privado a la plataforma.',
    });
    expect(updated.signinHeadline).toBe(
      'Formación en IA aplicada, con la comunidad que la usa cada día.',
    );
    expect(updated.signinSubheadline).toBe('Acceso privado a la plataforma.');
  });

  it('la cadena vacía limpia el campo (vuelve al genérico), no guarda ""', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await service.update(tenant, { signinHeadline: 'Algo' });
    const cleared = await service.update(tenant, { signinHeadline: '' });
    expect(cleared.signinHeadline).toBeNull();
  });

  it('rechaza un titular más largo que el máximo', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await expect(
      service.update(tenant, { signinHeadline: 'x'.repeat(MAX_SIGNIN_HEADLINE_CHARS + 1) }),
    ).rejects.toBeInstanceOf(SigninCopyTooLongError);
  });

  it('rechaza una línea de apoyo más larga que el máximo', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await expect(
      service.update(tenant, {
        signinSubheadline: 'x'.repeat(MAX_SIGNIN_SUBHEADLINE_CHARS + 1),
      }),
    ).rejects.toBeInstanceOf(SigninCopyTooLongError);
  });

  it('no toca el copy cuando la actualización no lo menciona', async () => {
    const prisma = makeFakePrisma();
    const service = new ThemingService(prisma as never, fakeCtx);
    await service.update(tenant, { signinHeadline: 'Mi titular' });
    const after = await service.update(tenant, { brandHue: 24 });
    expect(after.signinHeadline).toBe('Mi titular');
  });
});
