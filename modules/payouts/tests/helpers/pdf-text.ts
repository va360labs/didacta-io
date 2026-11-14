/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { inflateSync } from 'node:zlib';

/**
 * Texto de un PDF de pdfkit con fuentes estándar: cada operador `TJ` lleva el
 * texto como trozos hexadecimales en Windows-1252. Las líneas se unen con un
 * espacio (pdfkit parte los párrafos en espacios) y los espacios se colapsan,
 * para poder buscar frases enteras.
 */
export function pdfText(pdf: Buffer): string {
  const decoder = new TextDecoder('windows-1252');
  const lines: string[] = [];
  for (const m of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content = Buffer.from(m[1]!, 'latin1');
    try {
      content = inflateSync(content);
    } catch {
      // Stream sin comprimir: se lee tal cual.
    }
    for (const tj of content.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const hex = [...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]).join('');
      lines.push(decoder.decode(Buffer.from(hex, 'hex')));
    }
  }
  return lines.join(' ').replace(/\s+/g, ' ');
}
