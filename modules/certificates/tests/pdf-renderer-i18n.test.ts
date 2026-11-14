/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * El certificado en español, inglés y portugués. Se comprueba sobre el TEXTO
 * del PDF, extraído de sus streams: así se ve que Helvetica (WinAnsi) pinta
 * los acentos del portugués (ã, õ, ç, ê) y no un carácter roto, y que el
 * español sale con las mismas palabras de siempre.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_COPY,
  CERTIFICATE_LANGS,
  renderCertificatePdf,
  toCertificateLang,
} from '../src/pdf-renderer';

/**
 * Texto de un PDF de pdfkit con fuentes estándar: cada operador `TJ` lleva el
 * texto como trozos hexadecimales en Windows-1252. Las líneas se unen con un
 * espacio (pdfkit parte los párrafos largos en espacios) y los espacios se
 * colapsan, para poder buscar frases enteras.
 */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const lines: string[] = [];
  const decoder = new TextDecoder('windows-1252');
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content = Buffer.from(m[1]!, 'latin1');
    try {
      content = inflateSync(content);
    } catch {
      // Stream sin comprimir (o una imagen): se lee tal cual.
    }
    for (const tj of content.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const hex = [...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]).join('');
      lines.push(decoder.decode(Buffer.from(hex, 'hex')));
    }
  }
  return lines.join(' ').replace(/\s+/g, ' ');
}

const BASE = {
  number: 'LS-2026-000042',
  studentName: 'João Conceição',
  courseTitle: 'Introdução à automação',
  issuedAt: new Date('2026-04-25T12:00:00Z'),
};

describe('certificado por idioma', () => {
  it('español por defecto: los textos de siempre', async () => {
    const text = pdfText(await renderCertificatePdf(BASE));
    for (const esperado of [
      'CERTIFICADO',
      'DE FINALIZACIÓN',
      'Se otorga el presente certificado a',
      'Certifica que ha completado satisfactoriamente el curso indicado',
      'CURSO',
      'FECHA DE EMISIÓN',
      '25 de abril de 2026',
      'Certificado verificable · Nº LS-2026-000042',
    ]) {
      expect(text, esperado).toContain(esperado);
    }
    // Pasar `lang: 'es'` es exactamente lo mismo que no pasarlo.
    expect(pdfText(await renderCertificatePdf({ ...BASE, lang: 'es' }))).toBe(text);
  });

  it('portugués: título, rótulos, fecha pt-BR y acentos legibles (ã, õ, ç, ê)', async () => {
    const text = pdfText(await renderCertificatePdf({ ...BASE, lang: 'pt' }));
    for (const esperado of [
      'CERTIFICADO',
      'DE CONCLUSÃO',
      'Este certificado é concedido a',
      'João Conceição',
      'Certifica que concluiu satisfatoriamente o curso indicado',
      'critérios de conclusão estabelecidos.',
      'CURSO',
      'Introdução à automação',
      'DATA DE EMISSÃO',
      '25 de abril de 2026',
      'Certificado verificável · Nº LS-2026-000042',
    ]) {
      expect(text, esperado).toContain(esperado);
    }
    for (const espanol of ['FINALIZACIÓN', 'Se otorga', 'FECHA DE', 'verificable']) {
      expect(text, espanol).not.toContain(espanol);
    }
    expect(text).not.toContain('?');
  });

  it('inglés: título, rótulos y fecha en inglés', async () => {
    const text = pdfText(await renderCertificatePdf({ ...BASE, lang: 'en' }));
    for (const esperado of [
      'CERTIFICATE',
      'OF COMPLETION',
      'This certificate is awarded to',
      'COURSE',
      'ISSUE DATE',
      'April 25, 2026',
      'Verifiable certificate · No. LS-2026-000042',
    ]) {
      expect(text, esperado).toContain(esperado);
    }
  });

  it('el cuerpo de una plantilla es del aula: no se traduce', async () => {
    const text = pdfText(
      await renderCertificatePdf({ ...BASE, lang: 'pt', body: 'Texto propio de la academia.' }),
    );
    expect(text).toContain('Texto propio de la academia.');
    expect(text).not.toContain('Certifica que concluiu');
  });

  it('toCertificateLang: pt-BR → pt, en-GB → en; el resto (y nada) → español', () => {
    expect(toCertificateLang('pt-BR')).toBe('pt');
    expect(toCertificateLang('PT')).toBe('pt');
    expect(toCertificateLang('en-GB')).toBe('en');
    for (const otro of ['es-ES', 'es-AR', 'fr-FR', '', '  ', null, undefined]) {
      expect(toCertificateLang(otro), String(otro)).toBe('es');
    }
  });

  it('todos los idiomas tienen todos los textos', () => {
    const claves = Object.keys(CERTIFICATE_COPY.es).sort();
    for (const lang of CERTIFICATE_LANGS) {
      expect(Object.keys(CERTIFICATE_COPY[lang]).sort(), lang).toEqual(claves);
      for (const [k, v] of Object.entries(CERTIFICATE_COPY[lang])) {
        expect(v.trim().length, `${lang}.${k}`).toBeGreaterThan(0);
      }
      expect(CERTIFICATE_COPY[lang].verifiable, lang).toContain('{n}');
      expect(CERTIFICATE_COPY[lang].docTitle, lang).toContain('{n}');
    }
  });
});
