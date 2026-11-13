/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Scopes de la PUERTA DE AGENTES (servidor MCP del aula).
 *
 * Son verbos de producto —«crear cursos», «programar directos»—, no espejos de
 * los métodos internos: quien crea la clave razona sobre lo que el agente
 * podrá hacer en su aula, no sobre endpoints (misma regla que el ADR-022 de la
 * puerta de agentes de VA360, de la que esta es la adaptación al producto).
 *
 * ⛔ Deliberadamente FUERA de v1, y por eso no hay scope que lo conceda:
 *   - borrar nada (cursos, lecciones, clases, publicaciones);
 *   - dar de alta personas o invitarlas (crea cuentas y manda correos);
 *   - cobrar, poner precios o publicar a la venta. En el modo sencillo
 *     «publicar» es poner el curso a la venta con su precio, y un curso
 *     publicado SIN precio queda gratis para todo el aula
 *     (`LearningService.isFreeCourse`): las dos cosas tocan dinero;
 *   - avisar por correo a todo el aula (notifyAll de la comunidad).
 * Los cursos nuevos que crea un agente quedan en borrador y los publica la
 * persona desde «Empieza aquí». Los directos, las publicaciones de la comunidad
 * y las lecciones de un curso ya publicado se ven al momento.
 */
export const AGENT_SCOPES = [
  'agent:courses:read',
  'agent:courses:write',
  'agent:live:write',
  'agent:community:post',
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

const AGENT_SCOPE_SET: ReadonlySet<string> = new Set(AGENT_SCOPES);

/** ¿Es un scope de la puerta de agentes? */
export function isAgentScope(scope: string): scope is AgentScope {
  return AGENT_SCOPE_SET.has(scope);
}

/**
 * Lo que recibe la clave que se crea desde el panel «Hazlo más rápido con tu
 * agente de IA». Es el mínimo que cubre lo que hoy se hace a mano en el modo
 * sencillo (cursos y lecciones, directos y comunidad) y nada más: ni
 * matrículas, ni pedidos, ni lectura de alumnos.
 *
 * Lo fija el SERVIDOR (`POST /agent/keys` no acepta scopes del cliente): el
 * panel no puede pedir más de lo que hay aquí.
 */
export const PANEL_AGENT_SCOPES: readonly AgentScope[] = [...AGENT_SCOPES];
