/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * `seguimiento.csv` — la evidencia fina que faltaba en el paquete de auditoría
 * (LMS-121).
 *
 * El ZIP de auditoría llevaba los dos XML, el listado nominal, los costes y los
 * adjuntos RLPT. Todo correcto y todo agregado: por participante, una fila con
 * horas y resultado. Lo que la instrucción de seguimiento de Fundae pide mirar
 * —registros de interacción, recorrido por el itinerario, actividades
 * realizadas— sí estaba en la base de datos, pero no salía del sistema.
 *
 * Este CSV lo saca: UNA FILA POR PARTICIPANTE Y LECCIÓN, en el orden del
 * itinerario, con primer acceso, último acceso, tiempo registrado, si se
 * completó, cuándo, y —lo que decide si eso vale como evidencia— QUIÉN lo dio
 * por completado. Una fila con `origen=SELF` dice, sin ambigüedad, que ahí no
 * hay más respaldo que la palabra del alumno.
 *
 * Formato RFC 4180 con CRLF, igual que los otros CSV del paquete, y con BOM
 * a la cabeza porque el destinatario habitual lo abre con Excel y sin BOM se
 * come los acentos.
 */

export interface SeguimientoCsvRow {
  nifAlumno: string | null;
  email: string;
  nombre: string | null;
  /** Orden dentro del itinerario del curso, 1..N. */
  orden: number;
  moduloTitulo: string;
  leccionTitulo: string;
  tipo: string;
  duracionMinutos: number | null;
  primerAccesoAt: Date | null;
  ultimoAccesoAt: Date | null;
  segundosRegistrados: number;
  completada: boolean;
  completadaAt: Date | null;
  /** SELF | TIME | ASSESSMENT | SCORM | INSTRUCTOR, o vacío si no consta. */
  origenCompletado: string | null;
  /** ¿La completó un tercero que puede dar fe? Columna redundante a propósito:
   *  el auditor filtra por ella sin tener que conocer nuestro vocabulario. */
  verificada: boolean;
}

const HEADER = [
  'nif',
  'email',
  'nombre',
  'orden',
  'modulo',
  'leccion',
  'tipo',
  'duracion_min',
  'primer_acceso',
  'ultimo_acceso',
  'segundos_registrados',
  'completada',
  'fecha_completado',
  'origen_completado',
  'verificada',
];

export function buildSeguimientoCsv(rows: readonly SeguimientoCsvRow[]): string {
  const lines = rows.map((r) =>
    [
      csvEscape(r.nifAlumno ?? ''),
      csvEscape(r.email),
      csvEscape(r.nombre ?? ''),
      String(r.orden),
      csvEscape(r.moduloTitulo),
      csvEscape(r.leccionTitulo),
      csvEscape(r.tipo),
      r.duracionMinutos === null ? '' : String(r.duracionMinutos),
      iso(r.primerAccesoAt),
      iso(r.ultimoAccesoAt),
      String(Math.max(0, r.segundosRegistrados)),
      r.completada ? 'SI' : 'NO',
      iso(r.completadaAt),
      csvEscape(r.origenCompletado ?? ''),
      r.verificada ? 'SI' : 'NO',
    ].join(','),
  );
  return '﻿' + [HEADER.join(','), ...lines].join('\r\n') + '\r\n';
}

function iso(value: Date | null): string {
  return value === null ? '' : value.toISOString();
}

function csvEscape(value: string): string {
  // RFC 4180: quote si contiene coma, comilla, CR o LF; escape comillas duplicándolas.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
