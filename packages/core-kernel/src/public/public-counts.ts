/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cuándo enseña un aula sus cifras a quien entra SIN sesión: el panel de las
 * pantallas de acceso («N alumnos activos · N cursos»), los miembros de la
 * portada pública y los «N alumnos activos» de la página de venta de la
 * membresía (`/join`, en `mod.subscriptions`). Una sola regla para todas;
 * vive en el core-kernel para que el host y los módulos la compartan.
 *
 * Por qué hay umbral: una cifra pequeña no convence a nadie, al revés. En la
 * primera venta real de Didacta Cloud (14-nov-2026) la entrada del aula
 * presumía de «1 alumno activo · 1 curso». Por debajo del umbral no se enseña
 * ninguna cifra; tampoco la de cursos, que sola dice lo mismo.
 *
 * Se cuentan ALUMNOS: usuarios activos sin rol de equipo. El equipo no cuenta
 * para decidir (un aula recién creada tiene a su creadora y a nadie más).
 */

/** Roles de equipo: no son alumnos y no cuentan para el umbral. */
export const STAFF_ROLES: readonly string[] = ['super_admin', 'tenant_admin', 'formador'];

/** Alumnos a partir de los cuales el aula enseña sus cifras en público. */
export const MIN_STUDENTS_FOR_PUBLIC_COUNTS = 10;

/** ¿Tiene el aula alumnos suficientes para enseñar sus cifras? */
export function showsPublicCounts(students: number): boolean {
  return students >= MIN_STUDENTS_FOR_PUBLIC_COUNTS;
}
