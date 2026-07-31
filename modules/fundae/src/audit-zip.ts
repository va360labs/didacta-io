/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import archiver from 'archiver';

/**
 * Paquete de auditoría descargable Fundae (LMS-86).
 *
 * Contiene todo lo que un auditor externo (o la propia inspección de
 * Fundae) necesita para verificar la trazabilidad de un grupo bonificable
 * sin acceder al sistema:
 *
 *   manifest.json                 — metadatos + hashes SHA-256 de cada artefacto
 *   inicio.xml                    — comunicación de inicio (LMS-83)
 *   finalizacion.xml              — comunicación de finalización (LMS-85)
 *   participantes.csv             — listado nominal con NIF, horas, resultado
 *   costes.csv                    — desglose por tipo + total
 *   rlpt/notificacion-N.{ext}     — adjuntos RLPT (PDF/imagen) descargados de
 *                                   Evidence Vault — uno por notificación
 *
 * Hashes en manifest.json permiten verificar integridad sin recalcular
 * desde el ZIP (Fundae acepta esto como evidencia de no-tampering).
 */
export interface AuditZipInput {
  groupId: string;
  numeroGrupo: number;
  codigoAccion: string;
  empresaNif: string;
  generatedAt: Date;
  startXml: string;
  endXml: string;
  participantsCsv: string;
  costsCsv: string;
  rlptAttachments: Array<{
    /** Nombre interno: "rlpt/notificacion-{id}.pdf" o ".png" */
    filename: string;
    blob: Buffer;
    /** Para el manifest: tipo de notificación (NOTIFICACION_INICIAL, etc.) */
    tipo: string;
  }>;
}

interface ManifestEntry {
  filename: string;
  bytes: number;
  sha256: string;
}

interface AuditManifest {
  generadoEn: string;
  schema: string;
  grupo: {
    groupId: string;
    numeroGrupo: number;
    codigoAccion: string;
    empresaNif: string;
  };
  artefactos: ManifestEntry[];
  rlpt: Array<ManifestEntry & { tipo: string }>;
}

export async function buildAuditZip(input: AuditZipInput): Promise<Buffer> {
  const startBuf = Buffer.from(input.startXml, 'utf8');
  const endBuf = Buffer.from(input.endXml, 'utf8');
  const partsBuf = Buffer.from(input.participantsCsv, 'utf8');
  const costsBuf = Buffer.from(input.costsCsv, 'utf8');

  const manifest: AuditManifest = {
    generadoEn: input.generatedAt.toISOString(),
    schema: 'didacta-fundae-audit/v1',
    grupo: {
      groupId: input.groupId,
      numeroGrupo: input.numeroGrupo,
      codigoAccion: input.codigoAccion,
      empresaNif: input.empresaNif,
    },
    artefactos: [
      hashEntry('inicio.xml', startBuf),
      hashEntry('finalizacion.xml', endBuf),
      hashEntry('participantes.csv', partsBuf),
      hashEntry('costes.csv', costsBuf),
    ],
    rlpt: input.rlptAttachments.map((att) => ({
      ...hashEntry(att.filename, att.blob),
      tipo: att.tipo,
    })),
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });

    archive.append(manifestBuf, { name: 'manifest.json' });
    archive.append(startBuf, { name: 'inicio.xml' });
    archive.append(endBuf, { name: 'finalizacion.xml' });
    archive.append(partsBuf, { name: 'participantes.csv' });
    archive.append(costsBuf, { name: 'costes.csv' });
    for (const att of input.rlptAttachments) {
      archive.append(att.blob, { name: att.filename });
    }

    void archive.finalize();
  });
}

function hashEntry(filename: string, buf: Buffer): ManifestEntry {
  return {
    filename,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

// ─── CSV helpers (puros, sin dependencias) ────────────────────────────────

export interface ParticipantCsvRow {
  userId: string;
  nifAlumno: string | null;
  nombre: string | null;
  email: string;
  enrolledAt: string;
  status: string;
  horasAsistidas: number | null;
  progressPercent: number | null;
  resultado: string | null;
}

export function buildParticipantsCsv(rows: ParticipantCsvRow[]): string {
  const header = [
    'userId',
    'nif',
    'nombre',
    'email',
    'fecha_matricula',
    'status',
    'horas_asistidas',
    'progreso_pct',
    'resultado',
  ].join(',');
  const lines = rows.map((r) =>
    [
      csvEscape(r.userId),
      csvEscape(r.nifAlumno ?? ''),
      csvEscape(r.nombre ?? ''),
      csvEscape(r.email),
      csvEscape(r.enrolledAt),
      csvEscape(r.status),
      r.horasAsistidas === null ? '' : String(r.horasAsistidas),
      r.progressPercent === null ? '' : String(r.progressPercent),
      csvEscape(r.resultado ?? ''),
    ].join(','),
  );
  return [header, ...lines].join('\r\n') + '\r\n';
}

export interface CostCsvRow {
  tipo: string;
  concepto: string;
  importeCents: number;
  notas: string | null;
}

export function buildCostsCsv(rows: CostCsvRow[]): string {
  const header = ['tipo', 'concepto', 'importe_eur', 'notas'].join(',');
  const lines = rows.map((r) =>
    [
      csvEscape(r.tipo),
      csvEscape(r.concepto),
      (r.importeCents / 100).toFixed(2),
      csvEscape(r.notas ?? ''),
    ].join(','),
  );
  const total = rows.reduce((acc, r) => acc + r.importeCents, 0);
  const totalLine = ['TOTAL', '', (total / 100).toFixed(2), ''].join(',');
  return [header, ...lines, totalLine].join('\r\n') + '\r\n';
}

function csvEscape(value: string): string {
  // RFC 4180: quote si contiene coma, comilla, CR o LF; escape comillas duplicándolas.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
