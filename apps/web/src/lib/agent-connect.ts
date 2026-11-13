/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lógica pura del panel «Hazlo más rápido con tu agente de IA»: en qué
 * pantallas sale y qué comando o configuración se copia para cada agente.
 * Sin React ni red: ver `agent-connect.test.ts`.
 *
 * Cada comando sale de la documentación OFICIAL de su herramienta (la URL va en
 * `docs`). Solo hay agentes que pueden conectarse a un servidor MCP remoto por
 * HTTP enviando una cabecera `Authorization` fija: ChatGPT, que solo admite
 * OAuth o nada, no está.
 */

/**
 * Pantallas de GESTIÓN del modo sencillo en las que el panel aparece. Ni la
 * comunidad ni los espacios: son la zona de los miembros, y ahí el panel
 * (claves, comandos de terminal) estorba y confunde aunque quien mire sea el
 * administrador.
 */
export type AgentScreen = 'courses' | 'course-new' | 'course-edit' | 'live';

export interface AgentScreenMatch {
  screen: AgentScreen;
  /** En el editor de un curso, su id (para el ejemplo con el título real). */
  courseId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Las pantallas de gestión donde hoy se crea algo a mano y el agente puede
 * hacerlo por ti. Las que el agente NO puede hacer (invitar alumnos, precios y
 * publicación) se quedan fuera a propósito: el panel no promete lo que la
 * puerta de agentes no deja hacer. Y las zonas de miembro (comunidad,
 * espacios, cursos del alumno) tampoco, aunque el agente sepa publicar en la
 * comunidad: el panel solo se enseña donde se gestiona el aula.
 */
export function agentScreenFor(pathname: string | null | undefined): AgentScreenMatch | null {
  const path = (pathname ?? '').split('?')[0]!.replace(/\/+$/, '') || '/';
  if (path === '/studio/courses') return { screen: 'courses' };
  if (path === '/studio/courses/new') return { screen: 'course-new' };
  const course = /^\/studio\/courses\/([^/]+)$/.exec(path);
  if (course && UUID.test(course[1]!)) return { screen: 'course-edit', courseId: course[1] };
  if (path === '/studio/live') return { screen: 'live' };
  return null;
}

export const AGENT_IDS = ['claude-code', 'codex', 'hermes', 'grok', 'cursor', 'vscode'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_LABELS: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
  grok: 'Grok',
  cursor: 'Cursor',
  vscode: 'VS Code',
};

/**
 * Logo oficial de cada agente, servido desde `apps/web/public/agents/` (mismo
 * origen: nada de CDNs, que la CSP no deja). Son los SVG de la marca sin
 * redibujar: solo se recorta el lienzo al logo y se limpia el fichero.
 *
 * - Claude Code: la chispa del logo de code.claude.com (#D97757).
 * - Codex: el «Blossom» de OpenAI de openai.com/favicon.svg, en negro.
 * - Hermes: «Nous Girl» de assets/nous-girl-black.svg del repo oficial
 *   NousResearch/hermes-agent (MIT), el mismo del logo de su documentación.
 * - Grok: Grok_Logomark_Dark.svg del kit de marca de xAI (x.ai/legal/brand-guidelines).
 * - Cursor: CUBE_2D_LIGHT.svg del kit de marca de cursor.com/brand.
 * - VS Code: vscode.svg del kit de code.visualstudio.com/brand.
 *
 * El aula no tiene tema oscuro (la superficie del panel siempre es clara), así
 * que van las versiones para fondo claro.
 */
export const AGENT_LOGOS: Record<AgentId, string> = {
  'claude-code': '/agents/claude-code.svg',
  codex: '/agents/codex.svg',
  hermes: '/agents/hermes.svg',
  grok: '/agents/grok.svg',
  cursor: '/agents/cursor.svg',
  vscode: '/agents/vscode.svg',
};

/** Ruta del servidor MCP en el dominio del aula. */
export const MCP_PATH = '/api/v1/mcp';

export function mcpUrlFor(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${MCP_PATH}`;
}

/**
 * Nombre con el que el agente guarda la conexión: el del aula, en minúsculas
 * y con guiones (vale como clave TOML sin comillas, como nombre de servidor de
 * Claude Code y como clave YAML). Si no queda nada, `didacta`.
 */
export function serverNameFor(tenantSlug: string | null | undefined): string {
  const name = (tenantSlug ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return name || 'didacta';
}

export interface SnippetInput {
  url: string;
  /** La clave en claro, o el marcador si todavía no se ha creado. */
  key: string;
  name: string;
}

/**
 * Un bloque que se copia. `step` es la clave de i18n de la instrucción que va
 * encima (`agenteIa.agentes.<agente>.<step>`).
 */
export interface SnippetBlock {
  step: string;
  text: string;
}

export interface AgentSnippet {
  blocks: SnippetBlock[];
  /** Comando para comprobar que conectó, si la herramienta tiene uno. */
  verify: string | null;
  /** Documentación oficial de donde sale cada bloque. */
  docs: string[];
}

export function agentSnippet(agent: AgentId, { url, key, name }: SnippetInput): AgentSnippet {
  const bearer = `Bearer ${key}`;
  switch (agent) {
    case 'claude-code':
      return {
        blocks: [
          {
            step: 'paso',
            text: `claude mcp add --transport http --scope user ${name} ${url} --header "Authorization: ${bearer}"`,
          },
        ],
        verify: 'claude mcp list',
        docs: ['https://code.claude.com/docs/en/mcp'],
      };
    case 'codex':
      return {
        blocks: [
          {
            step: 'paso',
            text: [
              `[mcp_servers.${name}]`,
              `url = "${url}"`,
              `http_headers = { "Authorization" = "${bearer}" }`,
            ].join('\n'),
          },
        ],
        verify: 'codex mcp list',
        docs: [
          'https://developers.openai.com/codex/mcp',
          'https://learn.chatgpt.com/docs/config-file/config-reference',
        ],
      };
    case 'hermes':
      return {
        blocks: [
          {
            step: 'paso',
            text: [
              'mcp_servers:',
              `  ${name}:`,
              `    url: "${url}"`,
              '    headers:',
              `      Authorization: "${bearer}"`,
            ].join('\n'),
          },
        ],
        verify: `hermes mcp test ${name}`,
        docs: ['https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp'],
      };
    case 'grok':
      return {
        blocks: [
          { step: 'url', text: url },
          { step: 'cabecera', text: `Authorization: ${bearer}` },
          {
            step: 'terminal',
            text: `grok mcp add --transport http ${name} ${url} --header "Authorization: ${bearer}"`,
          },
        ],
        verify: `grok mcp list`,
        docs: [
          'https://docs.x.ai/grok-bot/computer-and-apps',
          'https://docs.x.ai/build/features/mcp-servers',
        ],
      };
    case 'cursor':
      return {
        blocks: [
          {
            step: 'paso',
            text: JSON.stringify(
              { mcpServers: { [name]: { url, headers: { Authorization: bearer } } } },
              null,
              2,
            ),
          },
        ],
        verify: null,
        docs: ['https://cursor.com/docs/context/mcp'],
      };
    case 'vscode':
      return {
        blocks: [
          {
            step: 'paso',
            text: JSON.stringify(
              {
                mcpServers: {
                  [name]: { type: 'http', url, headers: { Authorization: bearer } },
                },
              },
              null,
              2,
            ),
          },
        ],
        verify: null,
        docs: ['https://code.visualstudio.com/docs/agents/reference/mcp-configuration'],
      };
  }
}

/**
 * Texto del enlace a una guía oficial: su dominio. Si otra guía de la misma
 * lista comparte dominio (las dos de Grok son de docs.x.ai), se añade el
 * primer tramo de la ruta para que los dos enlaces no digan lo mismo.
 */
export function docsLabel(href: string, docs: readonly string[]): string {
  const host = (u: string) => new URL(u).hostname.replace(/^www\./, '');
  const mine = host(href);
  const shared = docs.filter((d) => host(d) === mine).length > 1;
  const first = new URL(href).pathname.split('/').find(Boolean);
  return shared && first ? `${mine}/${first}` : mine;
}

/** ¿Es una clave de la puerta de agentes? (tiene algún scope `agent:*`). */
export function isAgentKey(scopes: readonly string[]): boolean {
  return scopes.some((s) => s.startsWith('agent:'));
}

/** Preferencia «panel plegado», que se recuerda en el navegador. */
export const AGENT_PANEL_COLLAPSED_KEY = 'didacta:agente-ia:plegado';
export const AGENT_PANEL_TAB_KEY = 'didacta:agente-ia:pestana';

export function readCollapsed(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(AGENT_PANEL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeCollapsed(storage: Pick<Storage, 'setItem'> | null, value: boolean): void {
  try {
    storage?.setItem(AGENT_PANEL_COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    // Sin almacenamiento (modo privado, bloqueado): solo se pierde la preferencia.
  }
}

export function readTab(storage: Pick<Storage, 'getItem'> | null): AgentId {
  try {
    const v = storage?.getItem(AGENT_PANEL_TAB_KEY);
    return (AGENT_IDS as readonly string[]).includes(v ?? '') ? (v as AgentId) : 'claude-code';
  } catch {
    return 'claude-code';
  }
}

export function writeTab(storage: Pick<Storage, 'setItem'> | null, value: AgentId): void {
  try {
    storage?.setItem(AGENT_PANEL_TAB_KEY, value);
  } catch {
    // Igual que arriba.
  }
}
