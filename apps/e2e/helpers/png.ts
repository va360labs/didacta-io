/**
 * Generador de PNGs para los specs de imágenes.
 *
 * Se codifica a mano (filtro "None" + deflate sin comprimir) para no meter una
 * dependencia de imagen en el paquete e2e. El resultado es un PNG válido y
 * deliberadamente pesado — justo lo que hay que darle al optimizador para ver
 * si hace su trabajo.
 *
 * OJO con las fixtures diminutas: un PNG de 1x1 puede pesar menos que su
 * cabecera WebP, y entonces el optimizador lo deja intacto (con razón). Un spec
 * que espere WebP con una imagen así falla por culpa de la fixture, no del
 * código.
 */

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** Codifica RGBA crudo (`width*height*4` bytes) como PNG. */
export function encodePng(raw: Buffer, width: number, height: number): Buffer {
  const stride = width * 4 + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    rows[y * stride] = 0; // filtro "None"
    raw.copy(rows, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profundidad de bit
  ihdr[9] = 6; // color type RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * PNG opaco de `size`x`size` con un degradado suave: se parece a una foto o a
 * un logo con fondo, y WebP lo comprime muchísimo. Devuelto en base64 listo
 * para el body de los endpoints de subida.
 */
export function fotoPngBase64(size = 600): string {
  const raw = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      raw[i] = Math.round((x * 255) / size);
      raw[i + 1] = Math.round((y * 255) / size);
      raw[i + 2] = 128;
      raw[i + 3] = 255;
    }
  }
  return encodePng(raw, size, size).toString('base64');
}
