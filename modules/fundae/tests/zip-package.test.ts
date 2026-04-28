import { describe, expect, it } from 'vitest';
import { buildPresentationZip } from '../src/zip-package.js';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

describe('buildPresentationZip', () => {
  it('produce un ZIP con magic bytes PK\\x03\\x04', async () => {
    const buf = await buildPresentationZip({
      xmlFilename: 'accion-AF-2026-001.xml',
      xmlContent: '<?xml version="1.0"?><accionFormativa/>',
      evidences: [],
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(buf.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
  });

  it('mete el XML y los PDFs como entries', async () => {
    const fakePdf1 = Buffer.from('%PDF-1.4 fake1');
    const fakePdf2 = Buffer.from('%PDF-1.4 fake2');
    const buf = await buildPresentationZip({
      xmlFilename: 'accion-AF-X.xml',
      xmlContent: '<?xml version="1.0"?><a>x</a>',
      evidences: [
        { filename: 'evidencia-12345678Z.pdf', pdfData: fakePdf1 },
        { filename: 'evidencia-X1234567L.pdf', pdfData: fakePdf2 },
      ],
    });
    // El central directory de un ZIP guarda los nombres en claro al final.
    // Verificamos que el ZIP los contiene como substring del buffer.
    const text = buf.toString('binary');
    expect(text).toContain('accion-AF-X.xml');
    expect(text).toContain('evidencias/evidencia-12345678Z.pdf');
    expect(text).toContain('evidencias/evidencia-X1234567L.pdf');
  });
});
