/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests del envoltorio que da `uploadImage()` a cualquier backend de storage.
 *
 * Es la pieza que garantiza que TODA imagen de la plataforma se optimice al
 * subirla, venga del host, de un módulo first-party o de uno del marketplace.
 * Antes la optimización vivía solo en `StorageController`, así que cada vía
 * nueva nacía sin ella (así se coló el logo del tenant).
 *
 * Usa sharp de verdad, no un mock: lo que se está probando es justo el
 * resultado de comprimir.
 */

import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '@didacta/core-kernel';
import { withImageOptimization } from '../src/modules/image-optimizing-storage';

function makeAdapter() {
  const blobs = new Map<string, { buffer: Buffer; contentType?: string }>();
  const upload = vi.fn(async (key: string, data: Buffer | Uint8Array, contentType?: string) => {
    blobs.set(key, { buffer: Buffer.from(data), contentType });
    return { key };
  });
  const adapter = {
    upload,
    download: vi.fn(async (key: string) => blobs.get(key)!.buffer),
    delete: vi.fn(async (key: string) => void blobs.delete(key)),
    getSignedUrl: vi.fn(async (key: string) => `/files/${key}`),
  } as unknown as StorageAdapter;
  return { adapter, upload, blobs };
}

const SIZE = 800;
const CHANNELS = 3;

async function pngFrom(pixel: (x: number, y: number) => [number, number, number]): Promise<Buffer> {
  const raw = Buffer.alloc(SIZE * SIZE * CHANNELS);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * CHANNELS;
      const [r, g, b] = pixel(x, y);
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return sharp(raw, { raw: { width: SIZE, height: SIZE, channels: CHANNELS } })
    .png()
    .toBuffer();
}

/**
 * PNG con degradado suave: se parece a una foto y es lo que hace un upload
 * real. ~110 KB en PNG, ~6 KB en WebP.
 */
const makeFoto = () => pngFrom((x, y) => [(x * 255) / SIZE, (y * 255) / SIZE, 128]);

/**
 * PNG con una sierra de alta frecuencia que barre la imagen entera: los filtros
 * de PNG la dejan en ~18 KB, mientras que WebP con pérdida la engorda hasta
 * ~380 KB. Es el caso raro pero real que justifica el guard de "si no mejora,
 * guarda el original" — sin él, optimizar empeoraría lo que se sirve.
 */
async function makePatologica(): Promise<Buffer> {
  const raw = Buffer.alloc(SIZE * SIZE * CHANNELS);
  for (let i = 0; i < raw.length; i += CHANNELS) {
    const px = i / CHANNELS;
    raw[i] = (px * 7) % 256;
    raw[i + 1] = (px * 13) % 256;
    raw[i + 2] = (px * 29) % 256;
  }
  return sharp(raw, { raw: { width: SIZE, height: SIZE, channels: CHANNELS } })
    .png()
    .toBuffer();
}

describe('withImageOptimization · uploadImage', () => {
  let png: Buffer;

  beforeEach(async () => {
    png = await makeFoto();
  });

  it('recomprime un PNG a WebP y guarda bajo una key con la extensión correcta', async () => {
    const { adapter, upload, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);

    const out = await storage.uploadImage('tenants/t1/uploads/foto.png', png, 'image/png');

    expect(out.optimized).toBe(true);
    expect(out.contentType).toBe('image/webp');
    expect(out.key).toBe('tenants/t1/uploads/foto.webp');
    expect(out.size).toBeLessThan(out.previousSize);
    // Lo escrito en el backend es el blob recomprimido, no el original.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(blobs.get(out.key)!.buffer.length).toBe(out.size);
    expect(blobs.get(out.key)!.contentType).toBe('image/webp');
  });

  it('respeta maxWidth y nunca amplía', async () => {
    const { adapter, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);

    const out = await storage.uploadImage('k.png', png, 'image/png', { maxWidth: 200 });

    expect(out.width).toBe(200);
    const meta = await sharp(blobs.get(out.key)!.buffer).metadata();
    expect(meta.width).toBe(200);

    // Con un maxWidth mayor que el original, la imagen se queda como está.
    const grande = await storage.uploadImage('g.png', png, 'image/png', { maxWidth: 4000 });
    expect(grande.width).toBe(800);
  });

  it('un SVG se guarda intacto — es vectorial, recomprimirlo lo empeoraría', async () => {
    const { adapter, upload, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" /></svg>');

    const out = await storage.uploadImage('logo.svg', svg, 'image/svg+xml');

    expect(out.optimized).toBe(false);
    expect(out.key).toBe('logo.svg');
    expect(out.contentType).toBe('image/svg+xml');
    expect(upload).toHaveBeenCalledWith('logo.svg', svg, 'image/svg+xml');
    expect(blobs.get('logo.svg')!.buffer.equals(svg)).toBe(true);
  });

  it('un PDF pasa igual de intacto — `uploadImage` es seguro para no-imágenes', async () => {
    const { adapter, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);
    const pdf = Buffer.from('%PDF-1.7 contenido');

    const out = await storage.uploadImage('doc.pdf', pdf, 'application/pdf');

    expect(out.optimized).toBe(false);
    expect(out.contentType).toBe('application/pdf');
    expect(blobs.get('doc.pdf')!.buffer.equals(pdf)).toBe(true);
  });

  it('si recomprimir la engordaría, se guarda el original bajo la key pedida', async () => {
    const { adapter, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);
    const patologica = await makePatologica();

    const out = await storage.uploadImage('patron.png', patologica, 'image/png');

    // Ni se recomprime, ni cambia la extensión, ni se infla el fichero servido.
    expect(out.optimized).toBe(false);
    expect(out.key).toBe('patron.png');
    expect(out.contentType).toBe('image/png');
    expect(out.size).toBe(patologica.length);
    expect(blobs.get('patron.png')!.buffer.equals(patologica)).toBe(true);
  });

  it('una imagen corrupta no revienta la subida: se guarda el original', async () => {
    const { adapter, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);
    const basura = Buffer.from('esto no es un png por mucho que lo diga el content-type');

    const out = await storage.uploadImage('roto.png', basura, 'image/png');

    expect(out.optimized).toBe(false);
    expect(out.size).toBe(basura.length);
    expect(blobs.get('roto.png')!.buffer.equals(basura)).toBe(true);
  });

  it('una key con directorios solo cambia la extensión del último segmento', async () => {
    const { adapter } = makeAdapter();
    const storage = withImageOptimization(adapter);

    const out = await storage.uploadImage('tenants/a.b.c/branding/logo', png, 'image/png');

    // El punto del directorio NO se confunde con una extensión.
    expect(out.key).toBe('tenants/a.b.c/branding/logo.webp');
  });

  it('`upload` sigue siendo byte a byte — un ZIP o un SCORM no se tocan', async () => {
    const { adapter, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);

    await storage.upload('paquete/imagen.png', png, 'image/png');

    // Misma key, mismos bytes: quien necesita fidelidad la sigue teniendo.
    expect(blobs.get('paquete/imagen.png')!.buffer.equals(png)).toBe(true);
  });

  it('no reemplaza la instancia — el host sigue pudiendo comprobar el driver', async () => {
    class FakeS3 {
      async upload(key: string) {
        return { key };
      }
      async download() {
        return Buffer.alloc(0);
      }
      async delete() {}
      async getSignedUrl(key: string) {
        return key;
      }
    }
    const original = new FakeS3();
    const wrapped = withImageOptimization(original as unknown as StorageAdapter);

    // `isS3Storage()` del ModuleContextFactory hace justo este instanceof.
    expect(wrapped).toBeInstanceOf(FakeS3);
    expect(wrapped).toBe(original);
  });
});

/**
 * Regresión del 2026-07-30: al pasar el logo del tenant a WebP, los emails
 * empezaron a enseñar un rectángulo negro con las letras recortadas. El logo va
 * en la cabecera de todos los correos y hay clientes que decodifican el WebP
 * IGNORANDO su canal alfa, así que el fondo transparente se pinta con el RGB
 * que quedó debajo (negro). Por eso el logo se guarda en PNG.
 */
describe('withImageOptimization · uploadImage con format:"png" (imágenes de email)', () => {
  const ANCHO = 400;
  const ALTO = 105;

  /** PNG tipo logo: fondo transparente y una barra opaca en el centro. */
  async function makeLogoTransparente(): Promise<Buffer> {
    const raw = Buffer.alloc(ANCHO * ALTO * 4);
    for (let y = 0; y < ALTO; y++) {
      for (let x = 0; x < ANCHO; x++) {
        const i = (y * ANCHO + x) * 4;
        const dentro = y > 30 && y < 75 && x > 40 && x < 360;
        raw[i] = dentro ? 20 : 0;
        raw[i + 1] = dentro ? 20 : 0;
        raw[i + 2] = dentro ? 20 : 0;
        raw[i + 3] = dentro ? 255 : 0; // alfa: 0 fuera de las letras
      }
    }
    return sharp(raw, { raw: { width: ANCHO, height: ALTO, channels: 4 } })
      .png()
      .toBuffer();
  }

  /** WebP con alfa y ruido: en PNG NO cabe en menos bytes que en WebP. */
  async function makeWebpRuidoso(): Promise<Buffer> {
    const raw = Buffer.alloc(ANCHO * ALTO * 4);
    for (let i = 0; i < raw.length; i += 4) {
      const px = i / 4;
      raw[i] = (px * 37) % 256;
      raw[i + 1] = (px * 91) % 256;
      raw[i + 2] = (px * 173) % 256;
      raw[i + 3] = px % 7 === 0 ? 0 : 255;
    }
    return sharp(raw, { raw: { width: ANCHO, height: ALTO, channels: 4 } })
      .webp({ quality: 80 })
      .toBuffer();
  }

  /** ¿Qué alfa tiene el píxel (x,y) del blob guardado? */
  async function alphaEn(buffer: Buffer, x: number, y: number): Promise<number> {
    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * info.channels + 3]!;
  }

  it('guarda PNG (no WebP) y conserva la transparencia', async () => {
    const { adapter, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);
    const logo = await makeLogoTransparente();

    const out = await storage.uploadImage('tenants/t1/branding/logo.png', logo, 'image/png', {
      maxWidth: 512,
      format: 'png',
    });

    expect(out.contentType).toBe('image/png');
    expect(out.key).toBe('tenants/t1/branding/logo.png');
    const guardado = blobs.get(out.key)!;
    expect(guardado.contentType).toBe('image/png');
    expect((await sharp(guardado.buffer).metadata()).format).toBe('png');
    // Lo que rompía el email: el fondo tiene que seguir siendo transparente.
    expect(await alphaEn(guardado.buffer, 2, 2)).toBe(0);
    expect(await alphaEn(guardado.buffer, 200, 50)).toBe(255);
  });

  it('deja BLANCO el RGB bajo la transparencia (por si el cliente ignora el alfa)', async () => {
    const { adapter, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);
    // Logo "de manual": fondo transparente con negro debajo del alfa. Si el
    // cliente de email ignora el canal alfa, ese negro es el rectángulo negro.
    const logo = await makeLogoTransparente();

    const out = await storage.uploadImage('logo.png', logo, 'image/png', { format: 'png' });

    // Leemos el RGB CRUDO (sin componer con el alfa): es lo que ve un cliente
    // que decodifica la imagen y tira el canal alfa a la basura.
    const { data, info } = await sharp(blobs.get(out.key)!.buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // El fondo sale blanco, no negro: sobre la cabecera blanca del email, ni se ve.
    expect(px(2, 2)).toEqual([255, 255, 255]);
    // Y las letras siguen intactas.
    expect(px(200, 50)).toEqual([20, 20, 20]);
  });

  it('convierte un WebP a PNG aunque engorde — en el email el WebP no se ve', async () => {
    const { adapter, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);
    const webp = await makeWebpRuidoso();

    const out = await storage.uploadImage('tenants/t1/branding/logo.webp', webp, 'image/webp', {
      maxWidth: 512,
      format: 'png',
    });

    expect(out.contentType).toBe('image/png');
    expect(out.key).toBe('tenants/t1/branding/logo.png');
    // Es el caso que justifica la excepción al guard de tamaño.
    expect(out.size).toBeGreaterThan(out.previousSize);
    expect((await sharp(blobs.get(out.key)!.buffer).metadata()).format).toBe('png');
  });

  it('la excepción es solo para `format:"png"`: sin él manda el guard de tamaño', async () => {
    const { adapter, blobs } = makeAdapter();
    const storage = withImageOptimization(adapter);
    // La patológica engorda al pasar a WebP: es el caso que dispara el guard.
    const patologica = await makePatologica();

    const out = await storage.uploadImage('tenants/t1/uploads/patron.png', patologica, 'image/png');

    expect(out.optimized).toBe(false);
    expect(out.key).toBe('tenants/t1/uploads/patron.png');
    expect(blobs.get(out.key)!.buffer.equals(patologica)).toBe(true);
  });
});
