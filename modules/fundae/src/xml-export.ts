import type { ActionView } from './dto.js';

/**
 * Genera el XML de presentación Fundae para una acción formativa.
 *
 * **Disclaimer**: Esta es la versión v0.1 del export — un esqueleto que
 * incluye los campos básicos esperados por el formato Fundae. La spec real
 * tiene muchas más etiquetas (participantes, módulos, evaluación, evidencias)
 * y validaciones de negocio que se irán cubriendo en iteraciones siguientes
 * conforme tengamos casos reales contra el sistema oficial de la fundación.
 *
 * El consumidor del XML es:
 *  - Inicialmente un humano (admin de RRHH) que descarga, revisa y sube a
 *    Fundae manualmente.
 *  - A futuro, integración API directa con la fundación.
 *
 * Escapa los valores para evitar inyección XML.
 */
export function buildActionXml(action: ActionView): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<accionFormativa xmlns="https://www.fundae.es/schemas/accion/v1">',
    `  <codigoAccion>${escapeXml(action.codigoAccion)}</codigoAccion>`,
    `  <nombre>${escapeXml(action.nombre)}</nombre>`,
    `  <modalidad>${action.modalidad}</modalidad>`,
    `  <horasFormacion>${action.horasFormacion}</horasFormacion>`,
    `  <fechaInicio>${action.fechaInicio}</fechaInicio>`,
    `  <fechaFin>${action.fechaFin}</fechaFin>`,
  ];
  if (action.lugar) lines.push(`  <lugar>${escapeXml(action.lugar)}</lugar>`);
  if (action.cifCentro) lines.push(`  <cifCentro>${escapeXml(action.cifCentro)}</cifCentro>`);
  lines.push(`  <estado>${action.status}</estado>`);
  lines.push(`  <generadoEn>${new Date().toISOString()}</generadoEn>`);
  lines.push('</accionFormativa>');
  return lines.join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
