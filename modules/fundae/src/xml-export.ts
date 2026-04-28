import type { ActionView, Modalidad } from './dto.js';

export interface ParticipantSnapshot {
  userId: string;
  nombre: string | null;
  email: string;
  /** DNI/NIE si está registrado en el perfil del usuario. */
  dni: string | null;
  /** Estimación = horasFormacion × progressPercent / 100. */
  horasAsistidas: number;
  resultado: 'APTO' | 'NO_APTO' | 'EN_CURSO';
  enrolledAt: string;
  completedAt: string | null;
}

/**
 * Snapshot de un módulo formativo (bloque) tal como se renderiza en el XML.
 * Una acción puede tener N bloques con horas/modalidad propias.
 */
export interface BlockSnapshot {
  ordinal: number;
  title: string;
  hours: number;
  modalidad: Modalidad;
  contenidos: string;
}

/**
 * Genera el XML de presentación Fundae para una acción formativa.
 *
 * v0.3: incluye `<modulosFormativos>` cuando hay bloques registrados, y
 * `<participantes>` cuando se provee la lista. Sigue el formato estándar
 * (DNI, nombre, horas, resultado).
 *
 * Escapa los valores para evitar inyección XML.
 */
export function buildActionXml(
  action: ActionView,
  participants: ParticipantSnapshot[] = [],
  blocks: BlockSnapshot[] = [],
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

  if (blocks.length > 0) {
    lines.push(`  <modulosFormativos total="${blocks.length}">`);
    for (const b of blocks) {
      lines.push('    <modulo>');
      lines.push(`      <ordinal>${b.ordinal}</ordinal>`);
      lines.push(`      <title>${escapeXml(b.title)}</title>`);
      lines.push(`      <hours>${b.hours}</hours>`);
      lines.push(`      <modalidad>${b.modalidad}</modalidad>`);
      if (b.contenidos.trim()) {
        lines.push(`      <contenidos>${escapeXml(b.contenidos)}</contenidos>`);
      }
      lines.push('    </modulo>');
    }
    lines.push('  </modulosFormativos>');
  }

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
