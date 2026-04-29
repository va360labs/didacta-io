import type { ActionView, Modalidad } from './dto.js';
import type { GroupView, CostView, CostTipo } from './group.dto.js';
import type { CompanyView } from './company.dto.js';

/**
 * Snapshot final de un participante para el XML de finalización.
 * Incluye horas reales asistidas y resultado APTO/NO_APTO calculado por
 * `FundaeGroupService.computeCompletion` (LMS-84).
 */
export interface GroupParticipantFinalSnapshot {
  userId: string;
  nombre: string | null;
  email: string;
  nifAlumno: string | null;
  enrolledAt: string;
  /** Horas reales asistidas (calculadas desde progress del enrollment). */
  horasAsistidas: number;
  /** % de progreso capturado en el snapshot. */
  progressPercent: number;
  /** Resultado final Fundae. EN_CURSO solo se permite si el grupo aún
   * no se ha cerrado; al cerrar, los EN_CURSO se reportan como NO_APTO
   * en el XML. */
  resultado: 'APTO' | 'NO_APTO' | 'EN_CURSO';
  completedAt: string | null;
}

export interface BuildGroupEndXmlInput {
  group: GroupView;
  action: ActionView;
  company: CompanyView;
  participants: GroupParticipantFinalSnapshot[];
  costs: CostView[];
  /** Snapshot opcional del centro impartidor. Si no llega, se infiere
   * de `action.cifCentro`. */
  centro?: { cif: string; nombre?: string | null };
  /** Override del momento de generación (testing). */
  generatedAt?: Date;
}

/**
 * Genera el XML de "Comunicación de finalización de grupo" Fundae (LMS-85).
 *
 * Conforme al esquema oficial:
 *   - cabecera AccionFormativa
 *   - GrupoFormativo con fechas REALES (inicio + fin) y umbral aplicado
 *   - EmpresaBonificada
 *   - Centro (opcional)
 *   - ParticipantesFinales: lista nominal con NIF, horas asistidas y
 *     resultado APTO/NO_APTO. Los EN_CURSO se mapean a NO_APTO en el
 *     XML porque la fundación no acepta "en curso" en finalización.
 *   - Costes: agrupados por tipo (DIRECTO/INDIRECTO/ORGANIZACION) con
 *     desglose línea a línea + totales.
 *
 * Función PURA. El caller (FundaeGroupService) hace las queries y pasa
 * los datos hidratados.
 */
export function buildGroupEndXml(input: BuildGroupEndXmlInput): string {
  const { group, action, company, participants, costs } = input;
  const generatedAt = (input.generatedAt ?? new Date()).toISOString();

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<comunicacionFinalizacionGrupo xmlns="https://www.fundae.es/schemas/grupo-fin/v1">',
    `  <generadoEn>${generatedAt}</generadoEn>`,
  ];

  // ─── Acción formativa ────────────────────────────────────────────────
  lines.push('  <accionFormativa>');
  lines.push(`    <codigoAccion>${escapeXml(action.codigoAccion)}</codigoAccion>`);
  lines.push(`    <nombre>${escapeXml(action.nombre)}</nombre>`);
  lines.push(`    <modalidad>${action.modalidad as Modalidad}</modalidad>`);
  lines.push(`    <horasFormacion>${action.horasFormacion}</horasFormacion>`);
  lines.push('  </accionFormativa>');

  // ─── Grupo (con fechas reales) ───────────────────────────────────────
  lines.push('  <grupoFormativo>');
  lines.push(`    <numeroGrupo>${group.numeroGrupo}</numeroGrupo>`);
  lines.push(`    <modalidad>${group.modalidad}</modalidad>`);
  lines.push(`    <fechaInicioPrevista>${group.fechaInicioPrevista}</fechaInicioPrevista>`);
  lines.push(`    <fechaFinPrevista>${group.fechaFinPrevista}</fechaFinPrevista>`);
  if (group.fechaInicioReal) {
    lines.push(`    <fechaInicioReal>${group.fechaInicioReal}</fechaInicioReal>`);
  }
  if (group.fechaFinReal) {
    lines.push(`    <fechaFinReal>${group.fechaFinReal}</fechaFinReal>`);
  }
  lines.push(`    <estado>${group.status}</estado>`);
  lines.push(`    <umbralFinalizacionPct>${group.umbralFinalizacionPct}</umbralFinalizacionPct>`);
  if (group.creditoEstimadoCents !== null) {
    lines.push(
      `    <creditoEstimadoEur>${centsToEur(group.creditoEstimadoCents)}</creditoEstimadoEur>`,
    );
  }
  lines.push(
    `    <creditoConsumidoEur>${centsToEur(group.creditoConsumidoCents)}</creditoConsumidoEur>`,
  );
  lines.push('  </grupoFormativo>');

  // ─── Empresa bonificada ──────────────────────────────────────────────
  lines.push('  <empresaBonificada>');
  lines.push(`    <nif>${escapeXml(company.nif)}</nif>`);
  lines.push(`    <razonSocial>${escapeXml(company.razonSocial)}</razonSocial>`);
  if (company.cccPrincipal) {
    lines.push(`    <ccc>${escapeXml(company.cccPrincipal)}</ccc>`);
  }
  if (company.plantilla !== null) {
    lines.push(`    <plantilla>${company.plantilla}</plantilla>`);
  }
  lines.push('  </empresaBonificada>');

  // ─── Centro impartidor ───────────────────────────────────────────────
  const centro = input.centro ?? (action.cifCentro ? { cif: action.cifCentro } : null);
  if (centro) {
    lines.push('  <centro>');
    lines.push(`    <cif>${escapeXml(centro.cif)}</cif>`);
    if (centro.nombre) {
      lines.push(`    <nombre>${escapeXml(centro.nombre)}</nombre>`);
    }
    lines.push('  </centro>');
  }

  // ─── Participantes finales ───────────────────────────────────────────
  // EN_CURSO se reporta como NO_APTO al cerrar (Fundae no acepta
  // "en curso" en finalización; si no superó el umbral, no es bonificable).
  const aptos = participants.filter((p) => p.resultado === 'APTO').length;
  const noAptos = participants.length - aptos;
  lines.push(
    `  <participantesFinales total="${participants.length}" aptos="${aptos}" noAptos="${noAptos}">`,
  );
  for (const p of participants) {
    const resultadoFinal = p.resultado === 'APTO' ? 'APTO' : 'NO_APTO';
    lines.push('    <participante>');
    lines.push(`      <userId>${escapeXml(p.userId)}</userId>`);
    if (p.nifAlumno) {
      lines.push(`      <nif>${escapeXml(p.nifAlumno)}</nif>`);
    }
    if (p.nombre) {
      lines.push(`      <nombre>${escapeXml(p.nombre)}</nombre>`);
    }
    lines.push(`      <email>${escapeXml(p.email)}</email>`);
    lines.push(`      <fechaMatricula>${p.enrolledAt}</fechaMatricula>`);
    lines.push(`      <horasAsistidas>${p.horasAsistidas}</horasAsistidas>`);
    lines.push(`      <progresoPct>${p.progressPercent}</progresoPct>`);
    lines.push(`      <resultado>${resultadoFinal}</resultado>`);
    if (p.completedAt) {
      lines.push(`      <fechaCalculo>${p.completedAt}</fechaCalculo>`);
    }
    lines.push('    </participante>');
  }
  lines.push('  </participantesFinales>');

  // ─── Costes ──────────────────────────────────────────────────────────
  const totalsByTipo: Record<CostTipo, number> = {
    DIRECTO: 0,
    INDIRECTO: 0,
    ORGANIZACION: 0,
  };
  for (const c of costs) {
    totalsByTipo[c.tipo] += c.amountCents;
  }
  const totalCents = costs.reduce((acc, c) => acc + c.amountCents, 0);

  lines.push(`  <costes total="${costs.length}" importeTotalEur="${centsToEur(totalCents)}">`);
  for (const tipo of ['DIRECTO', 'INDIRECTO', 'ORGANIZACION'] as const) {
    const items = costs.filter((c) => c.tipo === tipo);
    lines.push(
      `    <bloque tipo="${tipo}" subtotalEur="${centsToEur(totalsByTipo[tipo])}" lineas="${items.length}">`,
    );
    for (const c of items) {
      lines.push('      <coste>');
      lines.push(`        <concepto>${escapeXml(c.concepto)}</concepto>`);
      lines.push(`        <importeEur>${centsToEur(c.amountCents)}</importeEur>`);
      if (c.notas) {
        lines.push(`        <notas>${escapeXml(c.notas)}</notas>`);
      }
      lines.push('      </coste>');
    }
    lines.push('    </bloque>');
  }
  lines.push('  </costes>');

  lines.push('</comunicacionFinalizacionGrupo>');
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

function centsToEur(cents: number): string {
  return (cents / 100).toFixed(2);
}
