import type { ActionView } from './dto.js';

export interface ParticipantSnapshot {
  userId: string;
  nombre: string | null;
  email: string;
  /** DNI/NIE si está registrado. v0.2: futuro campo del perfil del usuario. */
  dni: string | null;
  /** Estimación = horasFormacion × progressPercent / 100. */
  horasAsistidas: number;
  resultado: 'APTO' | 'NO_APTO' | 'EN_CURSO';
  enrolledAt: string;
  completedAt: string | null;
}

/**
 * Genera el XML de presentación Fundae para una acción formativa.
 *
 * v0.2: incluye `<participantes>` cuando se provee la lista. Sigue el
 * formato estándar (DNI, nombre, horas, resultado).
 *
 * Escapa los valores para evitar inyección XML.
 */
export function buildActionXml(
  action: ActionView,
  participants: ParticipantSnapshot[] = [],
): string {
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

  if (participants.length > 0) {
    lines.push(`  <participantes total="${participants.length}">`);
    for (const p of participants) {
      lines.push('    <participante>');
      lines.push(`      <userId>${escapeXml(p.userId)}</userId>`);
      if (p.dni) lines.push(`      <dni>${escapeXml(p.dni)}</dni>`);
      if (p.nombre) lines.push(`      <nombre>${escapeXml(p.nombre)}</nombre>`);
      lines.push(`      <email>${escapeXml(p.email)}</email>`);
      lines.push(`      <horasAsistidas>${p.horasAsistidas}</horasAsistidas>`);
      lines.push(`      <resultado>${p.resultado}</resultado>`);
      lines.push(`      <enrolledAt>${p.enrolledAt}</enrolledAt>`);
      if (p.completedAt) lines.push(`      <completedAt>${p.completedAt}</completedAt>`);
      lines.push('    </participante>');
    }
    lines.push('  </participantes>');
  }

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
