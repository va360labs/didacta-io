/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ABOUT_CHARS,
  MAX_COVER_BYTES,
  DEFAULT_THEME,
  updateThemeSchema,
  uploadCoverSchema,
} from '../src/dto.js';
import {
  AboutTooLongError,
  CoverNotFoundError,
  CoverTooLargeError,
  EmptyCoverError,
  InvalidSocialLinkError,
  TooManySocialLinksError,
  UnsupportedCoverTypeError,
} from '../src/errors.js';
import {
  MAX_SOCIAL_LINKS,
  parseSocialLinks,
  socialLinkProblem,
  type SocialLinkKind,
} from '../src/social-links.js';
import { ThemingService } from '../src/theming.service.js';

/**
 * La academia se presenta en su comunidad (tarjeta de /community, como un grupo
 * de Skool): descripción propia, enlaces sociales y portada. Todo vive en la
 * fila de `mod_theming_tenant_theme` de cada aula.
 */

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

type Row = Record<string, unknown> & { tenantId: string; updatedAt: Date };

/**
 * Base falsa con VARIAS aulas que exige `tenantId` en cada consulta, como hace
 * RLS en la real: si el service olvidara filtrar por aula, aquí reventaría.
 */
function makePrisma() {
  const rows = new Map<string, Row>();
  const need = (where: { tenantId?: unknown } | undefined): string => {
    if (typeof where?.tenantId !== 'string') throw new Error('consulta sin tenantId');
    return where.tenantId;
  };
  return {
    rows,
    modThemingTenantTheme: {
      async findUnique({ where }: { where: { tenantId: string } }) {
        return rows.get(need(where)) ?? null;
      },
      async create({ data }: { data: Partial<Row> & { tenantId: string } }) {
        const row: Row = {
          logoUrl: null,
          logoStorageKey: null,
          logoMimeType: null,
          logoDisplayMode: 'logo_only',
          faviconUrl: null,
          faviconStorageKey: null,
          faviconMimeType: null,
          brandHue: DEFAULT_THEME.brandHue,
          brandSaturation: DEFAULT_THEME.brandSaturation,
          displayFontFamily: DEFAULT_THEME.displayFontFamily,
          bodyFontFamily: DEFAULT_THEME.bodyFontFamily,
          customCss: null,
          footerHtml: null,
          signinHeadline: null,
          signinSubheadline: null,
          about: null,
          socialLinks: [],
          coverUrl: null,
          coverStorageKey: null,
          coverMimeType: null,
          ...data,
          updatedAt: new Date(),
        };
        rows.set(data.tenantId, row);
        return row;
      },
      async update({ where, data }: { where: { tenantId: string }; data: Partial<Row> }) {
        const t = need(where);
        const row = rows.get(t);
        if (!row) throw new Error('fila inexistente');
        const next = { ...row, ...data, updatedAt: new Date() };
        rows.set(t, next);
        return next;
      },
    },
  };
}

function makeStorage() {
  const blobs = new Map<string, { buffer: Buffer; contentType: string }>();
  const uploads: Array<{ key: string; opts: unknown }> = [];
  return {
    blobs,
    uploads,
    async upload(key: string, data: Buffer, contentType = 'application/octet-stream') {
      blobs.set(key, { buffer: Buffer.from(data), contentType });
      return { key };
    },
    // Como el core: las raster se recomprimen a WebP y cambian de key.
    async uploadImage(key: string, data: Buffer, contentType: string, opts?: unknown) {
      uploads.push({ key, opts });
      const raster = contentType !== 'image/svg+xml';
      const finalKey = raster ? `${key}.webp` : key;
      const finalType = raster ? 'image/webp' : contentType;
      blobs.set(finalKey, { buffer: Buffer.from(data), contentType: finalType });
      return {
        key: finalKey,
        contentType: finalType,
        optimized: raster,
        size: data.length,
        previousSize: data.length,
      };
    },
    async download(key: string) {
      const b = blobs.get(key);
      if (!b) throw new Error('not found');
      return b.buffer;
    },
    async delete(key: string) {
      blobs.delete(key);
    },
    async getSignedUrl(key: string) {
      return `/storage/${key}`;
    },
  };
}

function setup() {
  const prisma = makePrisma();
  const storage = makeStorage();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    storage,
    eventBus: { publish: async () => {} },
  };
  const service = new ThemingService(prisma as never, ctx as never);
  return { prisma, storage, service };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString(
  'base64',
);

describe('socialLinkProblem', () => {
  it.each<[SocialLinkKind, string]>([
    ['whatsapp', 'https://wa.me/34600000000'],
    ['whatsapp', 'https://chat.whatsapp.com/AbCdEf123'],
    ['whatsapp', 'https://whatsapp.com/channel/0029Va'],
    ['telegram', 'https://t.me/morningpour'],
    ['instagram', 'https://www.instagram.com/morningpour/'],
    ['instagram', 'https://instagram.com/'],
    ['youtube', 'https://youtu.be/abc'],
    ['youtube', 'https://m.youtube.com/@morningpour'],
    ['tiktok', 'https://www.tiktok.com/@morningpour'],
    ['facebook', 'https://facebook.com/morningpour'],
    ['linkedin', 'https://es.linkedin.com/company/morningpour'],
    ['x', 'https://x.com/morningpour'],
    ['x', 'https://twitter.com/morningpour'],
    ['web', 'https://morningpour.example.com/about'],
    ['web', '  https://morningpour.example.com  '],
  ])('%s acepta %s', (kind, url) => {
    expect(socialLinkProblem(kind, url)).toBeNull();
  });

  it.each<[SocialLinkKind, string, string]>([
    ['web', 'http://morningpour.example.com', 'https'],
    ['web', 'javascript:alert(1)', 'https'],
    ['web', 'data:text/html,<script>alert(1)</script>', 'https'],
    ['web', 'ftp://example.com', 'https'],
    ['web', 'https://exa mple.com', 'https'],
    ['web', 'https://', 'https'],
    ['web', 'https://localhost/x', 'host'],
    // Un usuario en la URL sirve para disfrazar el destino: wa.me@evil.com va a evil.com.
    ['whatsapp', 'https://wa.me@evil.example.com/', 'credentials'],
    // El icono promete la red: un «WhatsApp» que lleve a otro dominio no vale.
    ['whatsapp', 'https://evil.example.com/wa.me', 'host'],
    ['whatsapp', 'https://wa.me.evil.example.com/', 'host'],
    ['instagram', 'https://notinstagram.com/x', 'host'],
    ['x', 'https://x.com.evil.example.com/', 'host'],
    ['web', `https://example.com/${'a'.repeat(600)}`, 'length'],
  ])('%s rechaza %s (%s)', (kind, url, why) => {
    expect(socialLinkProblem(kind, url)).toBe(why);
  });
});

describe('updateThemeSchema · descripción y enlaces', () => {
  it('acepta hasta 5 enlaces válidos y una descripción de 280', () => {
    const r = updateThemeSchema.safeParse({
      about: 'a'.repeat(MAX_ABOUT_CHARS),
      socialLinks: Array.from({ length: MAX_SOCIAL_LINKS }, () => ({
        kind: 'web',
        url: 'https://morningpour.example.com',
      })),
    });
    expect(r.success).toBe(true);
  });

  it('rechaza un sexto enlace', () => {
    const r = updateThemeSchema.safeParse({
      socialLinks: Array.from({ length: MAX_SOCIAL_LINKS + 1 }, () => ({
        kind: 'web',
        url: 'https://morningpour.example.com',
      })),
    });
    expect(r.success).toBe(false);
  });

  it('rechaza una descripción de 281 caracteres', () => {
    expect(updateThemeSchema.safeParse({ about: 'a'.repeat(MAX_ABOUT_CHARS + 1) }).success).toBe(
      false,
    );
  });

  it('rechaza un enlace http, de otra red o de una red desconocida, con su razón', () => {
    const http = updateThemeSchema.safeParse({
      socialLinks: [{ kind: 'web', url: 'http://example.com' }],
    });
    expect(http.success).toBe(false);
    expect(http.error?.issues[0]?.message).toBe('https');
    expect(http.error?.issues[0]?.path).toEqual(['socialLinks', 0, 'url']);

    const ajeno = updateThemeSchema.safeParse({
      socialLinks: [{ kind: 'telegram', url: 'https://evil.example.com/t.me' }],
    });
    expect(ajeno.error?.issues[0]?.message).toBe('host');

    expect(
      updateThemeSchema.safeParse({ socialLinks: [{ kind: 'fax', url: 'https://example.com' }] })
        .success,
    ).toBe(false);
    // Campos de más dentro del enlace: tampoco (strict).
    expect(
      updateThemeSchema.safeParse({
        socialLinks: [{ kind: 'web', url: 'https://example.com', label: '<b>x</b>' }],
      }).success,
    ).toBe(false);
  });

  it('la portada no se pega como URL: solo se sube', () => {
    expect(updateThemeSchema.safeParse({ coverUrl: 'https://example.com/a.jpg' }).success).toBe(
      false,
    );
  });

  it('subir portada: los tipos del logo', () => {
    for (const contentType of ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']) {
      expect(uploadCoverSchema.safeParse({ data: PNG, filename: 'c', contentType }).success).toBe(
        true,
      );
    }
    expect(
      uploadCoverSchema.safeParse({ data: PNG, filename: 'c', contentType: 'image/gif' }).success,
    ).toBe(false);
  });
});

describe('ThemingService · descripción y enlaces', () => {
  it('guarda la descripción recortada y los enlaces en orden; vacía = sin descripción', async () => {
    const { service } = setup();
    const t = await service.update(A, {
      about: '  Home baristas learning together.  ',
      socialLinks: [
        { kind: 'instagram', url: ' https://instagram.com/ ' },
        { kind: 'whatsapp', url: 'https://wa.me/' },
      ],
    });
    expect(t.about).toBe('Home baristas learning together.');
    expect(t.socialLinks).toEqual([
      { kind: 'instagram', url: 'https://instagram.com/' },
      { kind: 'whatsapp', url: 'https://wa.me/' },
    ]);
    const vacia = await service.update(A, { about: '   ', socialLinks: [] });
    expect(vacia.about).toBeNull();
    expect(vacia.socialLinks).toEqual([]);
  });

  it('no tocar los campos no los borra', async () => {
    const { service } = setup();
    await service.update(A, {
      about: 'Hola',
      socialLinks: [{ kind: 'web', url: 'https://a.example.com' }],
    });
    const t = await service.update(A, { brandHue: 20 });
    expect(t.about).toBe('Hola');
    expect(t.socialLinks).toHaveLength(1);
  });

  it('sin pasar por el DTO, el service tampoco acepta enlaces malos ni de más', async () => {
    const { service, prisma } = setup();
    await expect(
      service.update(A, { socialLinks: [{ kind: 'whatsapp', url: 'https://evil.example.com' }] }),
    ).rejects.toBeInstanceOf(InvalidSocialLinkError);
    await expect(
      service.update(A, {
        socialLinks: [{ kind: 'fax' as never, url: 'https://example.com' }],
      }),
    ).rejects.toBeInstanceOf(InvalidSocialLinkError);
    await expect(
      service.update(A, {
        socialLinks: Array.from({ length: 6 }, () => ({
          kind: 'web' as const,
          url: 'https://example.com',
        })),
      }),
    ).rejects.toBeInstanceOf(TooManySocialLinksError);
    await expect(service.update(A, { about: 'x'.repeat(281) })).rejects.toBeInstanceOf(
      AboutTooLongError,
    );
    // Nada de lo rechazado llegó a la base.
    expect(prisma.rows.get(A)).toBeUndefined();
  });

  it('una columna editada a mano no propaga enlaces que el DTO no aceptaría', async () => {
    const { service, prisma } = setup();
    await service.getOrCreate(A);
    prisma.rows.get(A)!.socialLinks = [
      { kind: 'web', url: 'javascript:alert(1)' },
      { kind: 'instagram', url: 'https://instagram.com/ok' },
      42,
    ];
    expect((await service.getOrCreate(A)).socialLinks).toEqual([
      { kind: 'instagram', url: 'https://instagram.com/ok' },
    ]);
    expect(parseSocialLinks('no es una lista')).toEqual([]);
  });

  it('cada aula tiene lo suyo', async () => {
    const { service } = setup();
    await service.update(A, {
      about: 'De A',
      socialLinks: [{ kind: 'web', url: 'https://a.example.com' }],
    });
    const b = await service.getOrCreate(B);
    expect(b.about).toBeNull();
    expect(b.socialLinks).toEqual([]);
  });
});

describe('ThemingService · portada', () => {
  it('sube, sirve y la URL pública apunta al endpoint del aula', async () => {
    const { service, storage } = setup();
    const t = await service.uploadCover(A, {
      data: PNG,
      filename: 'portada.png',
      contentType: 'image/png',
    });
    expect(t.coverUploaded).toBe(true);
    expect(t.coverUrl).toMatch(new RegExp(`^/api/v1/modules/theming/tenants/${A}/cover\\?v=\\d+$`));
    // Bajo la carpeta de marca del aula, recomprimida como foto (1600 px).
    expect(storage.uploads).toEqual([
      { key: `tenants/${A}/branding/cover`, opts: { maxWidth: 1600 } },
    ]);
    const blob = await service.getCoverBlob(A);
    expect(blob.mimeType).toBe('image/webp');
    expect(blob.buffer.length).toBeGreaterThan(0);
  });

  it('cambiarla borra el blob anterior; quitarla limpia blob y columnas', async () => {
    const { service, storage } = setup();
    await service.uploadCover(A, { data: PNG, filename: 'a.svg', contentType: 'image/svg+xml' });
    expect(storage.blobs.has(`tenants/${A}/branding/cover`)).toBe(true);
    await service.uploadCover(A, { data: PNG, filename: 'b.png', contentType: 'image/png' });
    expect(storage.blobs.has(`tenants/${A}/branding/cover`)).toBe(false);
    expect(storage.blobs.has(`tenants/${A}/branding/cover.webp`)).toBe(true);

    const t = await service.removeCover(A);
    expect(t.coverUrl).toBeNull();
    expect(t.coverUploaded).toBe(false);
    expect(storage.blobs.size).toBe(0);
    await expect(service.getCoverBlob(A)).rejects.toBeInstanceOf(CoverNotFoundError);
  });

  it('rechaza tipo, vacío y tamaño sin tocar el storage', async () => {
    const { service, storage } = setup();
    await expect(
      service.uploadCover(A, { data: PNG, filename: 'a.gif', contentType: 'image/gif' }),
    ).rejects.toBeInstanceOf(UnsupportedCoverTypeError);
    await expect(
      service.uploadCover(A, { data: '', filename: 'a.png', contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(EmptyCoverError);
    const grande = Buffer.alloc(MAX_COVER_BYTES + 1, 1).toString('base64');
    await expect(
      service.uploadCover(A, { data: grande, filename: 'a.png', contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(CoverTooLargeError);
    expect(storage.uploads).toEqual([]);
  });

  it('la portada de un aula no es de la otra', async () => {
    const { service, storage } = setup();
    await service.uploadCover(A, { data: PNG, filename: 'a.png', contentType: 'image/png' });
    await service.getOrCreate(B);
    await expect(service.getCoverBlob(B)).rejects.toBeInstanceOf(CoverNotFoundError);
    // Quitar la de B no toca la de A.
    await service.removeCover(B);
    expect(storage.blobs.has(`tenants/${A}/branding/cover.webp`)).toBe(true);
    expect((await service.getOrCreate(A)).coverUploaded).toBe(true);
  });

  it('restaurar la marca quita portada, descripción y enlaces', async () => {
    const { service, storage } = setup();
    await service.uploadCover(A, { data: PNG, filename: 'a.png', contentType: 'image/png' });
    await service.update(A, {
      about: 'Hola',
      socialLinks: [{ kind: 'web', url: 'https://a.example.com' }],
    });
    const t = await service.reset(A);
    expect(t).toMatchObject({ about: null, socialLinks: [], coverUrl: null, coverUploaded: false });
    expect(storage.blobs.size).toBe(0);
  });
});
