import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  detectRasterContentType,
  isOptimizableImage,
  optimizeImage,
  swapExtension,
} from './image-optimizer';

/**
 * Genera un PNG con ruido determinista (no un color plano, que comprimiría a
 * casi nada y no sería representativo de una foto real).
 */
async function makeNoisyPng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  // Ruido de alta entropía (LCG determinista): un PNG de esto es casi
  // incompresible, así que representa una "foto pesada" real y el WebP lossy
  // redimensionado sí queda claramente más pequeño.
  let seed = 0x12345678;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (seed >> 16) & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe('isOptimizableImage', () => {
  it('acepta raster png/jpeg/webp/gif', () => {
    expect(isOptimizableImage('image/png')).toBe(true);
    expect(isOptimizableImage('image/jpeg')).toBe(true);
    expect(isOptimizableImage('image/webp')).toBe(true);
    expect(isOptimizableImage('image/gif')).toBe(true);
  });

  it('rechaza vectores y documentos', () => {
    expect(isOptimizableImage('image/svg+xml')).toBe(false);
    expect(isOptimizableImage('application/pdf')).toBe(false);
    expect(isOptimizableImage('text/plain')).toBe(false);
  });
});

describe('swapExtension', () => {
  it('reemplaza la extensión existente', () => {
    expect(swapExtension('foto.png', 'webp')).toBe('foto.webp');
    expect(swapExtension('a.b.jpeg', 'webp')).toBe('a.b.webp');
  });

  it('añade extensión si no la hay', () => {
    expect(swapExtension('foto', 'webp')).toBe('foto.webp');
    expect(swapExtension('', 'webp')).toBe('image.webp');
  });
});

describe('optimizeImage', () => {
  it('redimensiona a maxWidth y convierte a WebP más ligero', async () => {
    // Foto grande (2000px) servida a 1000px: es el caso real que resolvemos
    // (una portada pesada que se entrega redimensionada y en WebP).
    const png = await makeNoisyPng(2000, 1500);
    const result = await optimizeImage(png, 'image/png', { maxWidth: 1000 });

    expect(result.optimized).toBe(true);
    expect(result.contentType).toBe('image/webp');
    expect(result.extension).toBe('webp');
    expect(result.width).toBe(1000);
    expect(result.buffer.length).toBeLessThan(png.length);

    // El buffer resultante ES un WebP válido con el ancho esperado.
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1000);
  });

  it('no amplía imágenes más pequeñas que maxWidth', async () => {
    const png = await makeNoisyPng(800, 600);
    const result = await optimizeImage(png, 'image/png', { maxWidth: 1600 });

    // Puede quedar en webp; lo relevante es que NO se amplió a 1600.
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(800);
  });

  it('acota la calidad y el ancho a rangos seguros', async () => {
    const png = await makeNoisyPng(1000, 800);
    const result = await optimizeImage(png, 'image/png', { maxWidth: 999999, quality: 5 });
    // maxWidth se acota a 4096 → no amplía por encima del original (1000).
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(1000);
  });

  it('devuelve el original intacto para tipos no raster (passthrough)', async () => {
    const fakePdf = Buffer.from('%PDF-1.4 fake');
    const result = await optimizeImage(fakePdf, 'application/pdf');

    expect(result.optimized).toBe(false);
    expect(result.contentType).toBe('application/pdf');
    expect(result.buffer).toBe(fakePdf);
  });

  it('no rompe con un buffer corrupto: passthrough', async () => {
    const garbage = Buffer.from('esto no es una imagen');
    const result = await optimizeImage(garbage, 'image/png');

    expect(result.optimized).toBe(false);
    expect(result.buffer).toBe(garbage);
  });
});

describe('detectRasterContentType', () => {
  it('detecta el formato real de los bytes', async () => {
    const png = await makeNoisyPng(64, 64);
    expect(await detectRasterContentType(png)).toBe('image/png');

    const webp = await sharp(png).webp().toBuffer();
    expect(await detectRasterContentType(webp)).toBe('image/webp');
  });

  it('devuelve null para bytes que no son imagen', async () => {
    expect(await detectRasterContentType(Buffer.from('nope'))).toBeNull();
  });
});
