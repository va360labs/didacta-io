/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ActionView, Modalidad } from './dto.js';
import type { GroupView } from './group.dto.js';
import type { CompanyView } from './company.dto.js';

/**
 * Snapshot de un participante para el XML de inicio de grupo Fundae.
 * Mantiene el subset que la fundación exige al comunicar el inicio
 * (no se manda la nota de aprovechamiento aquí — eso va en finalización).
 */
export interface GroupParticipantSnapshot {
  userId: string;
  nombre: string | null;
  email: string;
  /** NIF que se snapshoteó al matricular. Fundae lo exige. Si es null,
   * el XML lo omite — la validación previa del export debería rechazar
   * esta situación porque sin NIF no se acepta el alta del participante. */
  nifAlumno: string | null;
  enrolledAt: string;
}

export interface BuildGroupStartXmlInput {
  group: GroupView;
  action: ActionView;
  company: CompanyView;
  participants: GroupParticipantSnapshot[];
  /** Snapshot opcional del centro impartidor / entidad organizadora.
   * Si no llega, se infiere del `action.cifCentro` cuando exista. */
  centro?: { cif: string; nombre?: string | null };
  /** Permite override del momento de generación (testing / runs deterministas). */
  generatedAt?: Date;
}

/**
 * Genera el XML de "Comunicación de inicio de grupo" Fundae (LMS-83).
 *
 * Conforme al esquema oficial de la fundación, contiene:
 *   - cabecera AccionFormativa (heredada de mod_fundae_action)
 *   - GrupoFormativo (datos del grupo)
 *   - EmpresaBonificada (NIF + razón social + CCC + plantilla)
 *   - Centro (cif + nombre, opcional)
 *   - ParticipantesIniciales (lista nominal con NIF, nombre, email)
 *
 * Todos los valores se escapan para evitar inyección XML. La función
 * es PURA: el caller (FundaeGroupService) hace las queries y se las
 * pasa ya hidratadas.
 */
export function buildGroupStartXml(input: BuildGroupStartXmlInput): string {
  const { group, action, company, participants } = input;
  const generatedAt = (input.generatedAt ?? new Date()).toISOString();

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<comunicacionInicioGrupo xmlns="https://www.fundae.es/schemas/grupo-inicio/v1">',
    `  <generadoEn>${generatedAt}</generadoEn>`,
  ];

  // ─── Acción formativa ────────────────────────────────────────────────
  lines.push('  <accionFormativa>');
  lines.push(`    <codigoAccion>${escapeXml(action.codigoAccion)}</codigoAccion>`);
  lines.push(`    <nombre>${escapeXml(action.nombre)}</nombre>`);
  lines.push(`    <modalidad>${action.modalidad as Modalidad}</modalidad>`);
  lines.push(`    <horasFormacion>${action.horasFormacion}</horasFormacion>`);
  lines.push('  </accionFormativa>');

  // ─── Grupo ───────────────────────────────────────────────────────────
  lines.push('  <grupoFormativo>');
  lines.push(`    <numeroGrupo>${group.numeroGrupo}</numeroGrupo>`);
  lines.push(`    <modalidad>${group.modalidad}</modalidad>`);
  lines.push(`    <fechaInicioPrevista>${group.fechaInicioPrevista}</fechaInicioPrevista>`);
  lines.push(`    <fechaFinPrevista>${group.fechaFinPrevista}</fechaFinPrevista>`);
  if (group.fechaInicioReal) {
    lines.push(`    <fechaInicioReal>${group.fechaInicioReal}</fechaInicioReal>`);
  }
  lines.push(`    <estado>${group.status}</estado>`);
  if (group.creditoEstimadoCents !== null) {
    lines.push(
      `    <creditoEstimadoEur>${centsToEur(group.creditoEstimadoCents)}</creditoEstimadoEur>`,
    );
  }
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
  if (company.creditoTotalCents !== null) {
    lines.push(`    <creditoTotalEur>${centsToEur(company.creditoTotalCents)}</creditoTotalEur>`);
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

  // ─── Participantes iniciales ─────────────────────────────────────────
  lines.push(`  <participantesIniciales total="${participants.length}">`);
  for (const p of participants) {
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
    lines.push('    </participante>');
  }
  lines.push('  </participantesIniciales>');

  lines.push('</comunicacionInicioGrupo>');
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
