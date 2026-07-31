import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { buildAuditZip, buildCostsCsv, buildParticipantsCsv } from '../src/audit-zip.js';

/**
 * Tests del paquete de auditoría Fundae (LMS-86).
 *
 * El builder es puro (sin dependencias de DB / storage). Comprobamos:
 *   - Estructura del ZIP (manifest.json + archivos esperados).
 *   - Hashes SHA-256 en manifest coinciden con el contenido de cada artefacto.
 *   - CSV escape correcto (RFC 4180).
 */

describe('buildAuditZip (LMS-86)', () => {
  it('genera ZIP con manifest.json y todos los artefactos', async () => {
    const zip = await buildAuditZip({
      groupId: 'g1',
      numeroGrupo: 1,
      codigoAccion: 'ACC-001',
      empresaNif: 'P1234567D',
      generatedAt: new Date('2026-04-29T13:00:00Z'),
      startXml: '<?xml version="1.0"?><inicio/>',
      endXml: '<?xml version="1.0"?><fin/>',
      participantsCsv: 'userId,nif\nu1,12345678Z\n',
      costsCsv: 'tipo,importe_eur\nDIRECTO,100.00\n',
      rlptAttachments: [
        {
          filename: 'rlpt/notificacion-r1.pdf',
          blob: Buffer.from('FAKE-PDF-CONTENT'),
          tipo: 'NOTIFICACION_INICIAL',
        },
      ],
    });

    const adm = new AdmZip(zip);
    const entries = adm
      .getEntries()
      .map((e) => e.entryName)
      .sort();
    expect(entries).toEqual([
      'costes.csv',
      'finalizacion.xml',
      'inicio.xml',
      'manifest.json',
      'participantes.csv',
      'rlpt/notificacion-r1.pdf',
    ]);

    const manifestRaw = adm.readAsText('manifest.json');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.schema).toBe('didacta-fundae-audit/v1');
    expect(manifest.grupo.numeroGrupo).toBe(1);
    expect(manifest.grupo.codigoAccion).toBe('ACC-001');
    expect(manifest.grupo.empresaNif).toBe('P1234567D');
    expect(manifest.artefactos).toHaveLength(4);
    expect(manifest.rlpt).toHaveLength(1);
    expect(manifest.rlpt[0].tipo).toBe('NOTIFICACION_INICIAL');
  });

  it('hashes SHA-256 del manifest coinciden con contenido real de los archivos', async () => {
    const zip = await buildAuditZip({
      groupId: 'g1',
      numeroGrupo: 1,
      codigoAccion: 'ACC-001',
      empresaNif: 'P1234567D',
      generatedAt: new Date('2026-04-29T13:00:00Z'),
      startXml: '<?xml version="1.0"?><inicio/>',
      endXml: '<?xml version="1.0"?><fin/>',
      participantsCsv: 'header\nrow1\n',
      costsCsv: 'header\nrow1\n',
      rlptAttachments: [],
    });
    const adm = new AdmZip(zip);
    const manifest = JSON.parse(adm.readAsText('manifest.json'));
    const inicioBuf = adm.readFile('inicio.xml')!;
    const inicioEntry = manifest.artefactos.find(
      (a: { filename: string }) => a.filename === 'inicio.xml',
    );
    expect(inicioEntry).toBeDefined();
    expect(inicioEntry.bytes).toBe(inicioBuf.length);
    // SHA-256 del contenido real coincide
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(inicioBuf).digest('hex');
    expect(inicioEntry.sha256).toBe(expected);
  });

  it('soporta sin RLPT attachments', async () => {
    const zip = await buildAuditZip({
      groupId: 'g1',
      numeroGrupo: 1,
      codigoAccion: 'ACC-001',
      empresaNif: 'P1234567D',
      generatedAt: new Date(),
      startXml: '<a/>',
      endXml: '<b/>',
      participantsCsv: '',
      costsCsv: '',
      rlptAttachments: [],
    });
    const adm = new AdmZip(zip);
    const manifest = JSON.parse(adm.readAsText('manifest.json'));
    expect(manifest.rlpt).toEqual([]);
    const entries = adm.getEntries().map((e) => e.entryName);
    expect(entries.some((e) => e.startsWith('rlpt/'))).toBe(false);
  });
});

describe('buildParticipantsCsv', () => {
  it('genera CSV con header y filas, empty fields como vacío', () => {
    const csv = buildParticipantsCsv([
      {
        userId: 'u1',
        nifAlumno: '12345678Z',
        nombre: 'Juan',
        email: 'juan@x.com',
        enrolledAt: '2026-04-28T00:00:00.000Z',
        status: 'ENROLLED',
        horasAsistidas: 18,
        progressPercent: 90,
        resultado: 'APTO',
      },
      {
        userId: 'u2',
        nifAlumno: null,
        nombre: null,
        email: 'maria@x.com',
        enrolledAt: '2026-04-28T00:00:00.000Z',
        status: 'REMOVED',
        horasAsistidas: null,
        progressPercent: null,
        resultado: null,
      },
    ]);
    expect(csv).toContain(
      'userId,nif,nombre,email,fecha_matricula,status,horas_asistidas,progreso_pct,resultado',
    );
    expect(csv).toContain(
      'u1,12345678Z,Juan,juan@x.com,2026-04-28T00:00:00.000Z,ENROLLED,18,90,APTO',
    );
    expect(csv).toContain('u2,,,maria@x.com,2026-04-28T00:00:00.000Z,REMOVED,,,');
  });

  it('escapa comas y comillas en el nombre', () => {
    const csv = buildParticipantsCsv([
      {
        userId: 'u1',
        nifAlumno: null,
        nombre: 'Juan, "El de Madrid"',
        email: 'j@x.com',
        enrolledAt: '2026-04-28T00:00:00.000Z',
        status: 'ENROLLED',
        horasAsistidas: 10,
        progressPercent: 50,
        resultado: 'NO_APTO',
      },
    ]);
    expect(csv).toContain('"Juan, ""El de Madrid"""');
  });
});

describe('buildCostsCsv', () => {
  it('genera CSV con totales en última línea', () => {
    const csv = buildCostsCsv([
      { tipo: 'DIRECTO', concepto: 'Formador', importeCents: 30_000_00, notas: null },
      { tipo: 'INDIRECTO', concepto: 'Gestión', importeCents: 5_000_00, notas: 'Factura #42' },
    ]);
    expect(csv).toContain('tipo,concepto,importe_eur,notas');
    expect(csv).toContain('DIRECTO,Formador,30000.00,');
    expect(csv).toContain('INDIRECTO,Gestión,5000.00,Factura #42');
    expect(csv).toContain('TOTAL,,35000.00,');
  });

  it('lista vacía → solo header + total 0.00', () => {
    const csv = buildCostsCsv([]);
    expect(csv).toContain('tipo,concepto,importe_eur,notas');
    expect(csv).toContain('TOTAL,,0.00,');
  });
});
