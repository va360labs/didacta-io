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
      signerName: 'Valentín Ayesa',
      signerTitle: 'Director Académico',
    });
    expect(buf.length).toBeGreaterThan(1000);
  });
});
