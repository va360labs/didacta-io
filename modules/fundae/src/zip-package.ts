/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import archiver from 'archiver';

/**
 * Entrada para el ZIP de presentación Fundae. Contiene el XML de la
 * acción y un PDF por participante con las evidencias firmadas.
 */
export interface ZipPackageInput {
  /** Nombre del XML dentro del ZIP, ej. "fundae-AF-2026-001.xml". */
  xmlFilename: string;
  /** Contenido completo del XML como string UTF-8. */
  xmlContent: string;
  /** Evidencias por participante. El nombre del archivo ya viene resuelto. */
  evidences: Array<{
    /** Nombre dentro del ZIP, ej. "evidencia-12345678Z.pdf". */
    filename: string;
    /** Contenido del PDF como Buffer. */
    pdfData: Buffer;
  }>;
}

/**
 * Empaqueta el XML + N PDFs en un único ZIP listo para subir a la
 * plataforma de Fundae. Devuelve un Buffer con el ZIP completo.
 *
 * Estructura interna:
 *   acción.xml
 *   evidencias/
 *     evidencia-{dni}.pdf
 *     evidencia-{userId}.pdf  (fallback si el participante no declaró DNI)
 */
export async function buildPresentationZip(input: ZipPackageInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', {
      // zlib level 6 = balance entre tamaño y CPU. Estos ZIPs son chicos
      // (KB-rango) y se generan on-demand, no vale la pena maximizar.
      zlib: { level: 6 },
    });

    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    // archiver emite warnings (ej. archivos vacíos): no los tratamos como
    // error fatal porque el contenido del ZIP queda válido igual.
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });

    archive.append(input.xmlContent, { name: input.xmlFilename });
    // Red de seguridad contra nombres repetidos: dos entradas con el mismo
    // nombre dentro del ZIP hacen que el revisor de Fundae solo vea una, sin
    // que nada avise. Puede pasar por datos del origen (dos participantes con
    // el mismo DNI mal tecleado) además de por el nombre que compone el
    // service. Se desempata en vez de perder la evidencia.
    const usados = new Set<string>();
    for (const evidence of input.evidences) {
      let nombre = evidence.filename;
      for (let n = 2; usados.has(nombre); n++) {
        const punto = evidence.filename.lastIndexOf('.');
        nombre =
          punto > 0
            ? `${evidence.filename.slice(0, punto)}-${n}${evidence.filename.slice(punto)}`
            : `${evidence.filename}-${n}`;
      }
      usados.add(nombre);
      archive.append(evidence.pdfData, { name: `evidencias/${nombre}` });
    }

    void archive.finalize();
  });
}
