import { describe, expect, it } from 'vitest';
import { renderEvidencePdf } from '../src/evidence-pdf.js';
import type { ActionView } from '../src/dto.js';

const ACTION: ActionView = {
  id: 'act-1',
  tenantId: 't-1',
  courseId: 'course-1',
  codigoAccion: 'AF-2026-001',
  nombre: 'Curso piloto',
  modalidad: 'TELEFORMACION',
  horasFormacion: 20,
  fechaInicio: '2026-05-01',
  fechaFin: '2026-05-30',
  lugar: 'On-line',
  cifCentro: 'B12345678',
  notas: null,
  status: 'ACTIVE',
  createdAt: '2026-04-28T00:00:00.000Z',
  updatedAt: '2026-04-28T00:00:00.000Z',
};

describe('renderEvidencePdf', () => {
  it('genera un PDF con magic bytes %PDF', async () => {
    const buf = await renderEvidencePdf({
      action: ACTION,
      centerName: 'Centro Demo',
      cifCentro: ACTION.cifCentro,
      participantName: 'María García',
      participantEmail: 'maria@example.com',
      participantDni: '12345678Z',
      horasAsistidas: 18,
      resultado: 'APTO',
      enrolledAt: new Date('2026-05-01T00:00:00Z'),
      completedAt: new Date('2026-05-29T00:00:00Z'),
      signerName: 'Firmante Ejemplo',
      signerTitle: 'Tenant admin',
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(500); // un PDF mínimo nunca pesa menos que esto
    expect(buf.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  it('soporta participante sin DNI sin romper', async () => {
    const buf = await renderEvidencePdf({
      action: ACTION,
      centerName: 'Centro Demo',
      participantName: 'Juan',
      participantEmail: 'juan@example.com',
      participantDni: null,
      horasAsistidas: 10,
      resultado: 'EN_CURSO',
      enrolledAt: new Date('2026-05-01T00:00:00Z'),
      completedAt: null,
      signerName: 'Admin',
    });
    expect(buf.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  it('cada resultado (APTO/NO_APTO/EN_CURSO) renderiza válido', async () => {
    for (const resultado of ['APTO', 'NO_APTO', 'EN_CURSO'] as const) {
      const buf = await renderEvidencePdf({
        action: ACTION,
        centerName: 'C',
        participantName: 'X',
        participantEmail: 'x@x.com',
        participantDni: null,
        horasAsistidas: 1,
        resultado,
        enrolledAt: new Date(),
        completedAt: null,
        signerName: 'S',
      });
      expect(buf.subarray(0, 4).toString('utf8')).toBe('%PDF');
    }
  });
});
