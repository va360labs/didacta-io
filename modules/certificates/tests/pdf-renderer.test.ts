import { describe, expect, it } from 'vitest';
import { renderCertificatePdf } from '../src/pdf-renderer';

describe('renderCertificatePdf', () => {
  it('genera un PDF válido (firma %PDF-)', async () => {
    const buf = await renderCertificatePdf({
      number: 'LS-2026-000001',
      studentName: 'María García',
      courseTitle: 'Introducción a n8n',
      issuedAt: new Date('2026-04-25'),
    });
    expect(buf.length).toBeGreaterThan(1000);
    const header = buf.slice(0, 5).toString('utf-8');
    expect(header).toBe('%PDF-');
  });

  it('soporta firma del firmante y color custom', async () => {
    const buf = await renderCertificatePdf({
      number: 'LS-2026-000002',
      studentName: 'Juan Pérez',
      courseTitle: 'Avanzado',
      issuedAt: new Date(),
      primaryColor: '#3b82f6',
      signerName: 'Firmante Ejemplo',
      signerTitle: 'Director Académico',
    });
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('embebe el logo cuando se provee logoData válido (PNG 1x1)', async () => {
    // PNG 1x1 transparente — minimal válido para pdfkit.
    const transparentPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      'base64',
    );
    const buf = await renderCertificatePdf({
      number: 'LS-2026-000003',
      studentName: 'María García',
      courseTitle: 'Curso con logo',
      issuedAt: new Date(),
      logoData: transparentPng,
    });
    const header = buf.slice(0, 5).toString('utf-8');
    expect(header).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('si logoData es un buffer corrupto NO rompe la emisión', async () => {
    const garbage = Buffer.from('not-an-image-at-all');
    const buf = await renderCertificatePdf({
      number: 'LS-2026-000004',
      studentName: 'Alumno X',
      courseTitle: 'Curso resiliente',
      issuedAt: new Date(),
      logoData: garbage,
    });
    expect(buf.slice(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});
