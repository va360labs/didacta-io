/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  AGENT_LOGOS,
  agentScreenFor,
  agentSnippet,
  docsLabel,
  isAgentKey,
  mcpUrlFor,
  readCollapsed,
  readTab,
  serverNameFor,
  writeCollapsed,
} from './agent-connect';

const ID = '6b09d3a3-cd99-46cc-b4fa-3793f908b4af';
const IN = {
  url: 'https://morningpour.didacta.io/api/v1/mcp',
  key: 'lmsk_abc',
  name: 'morningpour',
};

describe('agentScreenFor: solo las pantallas de creación manual', () => {
  it.each([
    ['/formador/cursos', 'courses'],
    ['/formador/cursos/', 'courses'],
    ['/formador/cursos/nuevo', 'course-new'],
    [`/formador/cursos/${ID}`, 'course-edit'],
    [`/formador/cursos/${ID}?anadir=1`, 'course-edit'],
    ['/formador/aula-virtual', 'live'],
    ['/comunidad', 'community'],
    ['/espacios/general', 'community'],
  ])('%s → %s', (path, screen) => {
    expect(agentScreenFor(path)?.screen).toBe(screen);
  });

  it('el editor lleva el id del curso para el ejemplo', () => {
    expect(agentScreenFor(`/formador/cursos/${ID}`)).toEqual({
      screen: 'course-edit',
      courseId: ID,
    });
  });

  it.each([
    '/empieza',
    '/admin/usuarios', // invitar: el agente no da de alta personas
    '/admin/cobros', // precios y cobros: tocan dinero
    '/formador/cursos/no-es-un-id',
    '/comunidad/menciones',
    '/cursos',
    '',
    null,
  ])('%s → sin panel', (path) => {
    expect(agentScreenFor(path)).toBeNull();
  });
});

describe('comandos por agente', () => {
  it('Claude Code: claude mcp add por HTTP con la cabecera', () => {
    expect(agentSnippet('claude-code', IN).blocks[0]!.text).toBe(
      'claude mcp add --transport http --scope user morningpour https://morningpour.didacta.io/api/v1/mcp --header "Authorization: Bearer lmsk_abc"',
    );
  });

  it('Codex: tabla TOML con url y http_headers', () => {
    expect(agentSnippet('codex', IN).blocks[0]!.text).toBe(
      [
        '[mcp_servers.morningpour]',
        'url = "https://morningpour.didacta.io/api/v1/mcp"',
        'http_headers = { "Authorization" = "Bearer lmsk_abc" }',
      ].join('\n'),
    );
  });

  it('Hermes: YAML con url y headers', () => {
    const t = agentSnippet('hermes', IN).blocks[0]!.text;
    expect(t).toContain('mcp_servers:\n  morningpour:\n');
    expect(t).toContain('Authorization: "Bearer lmsk_abc"');
  });

  it('Cursor y VS Code: JSON válido con la cabecera', () => {
    const cursor = JSON.parse(agentSnippet('cursor', IN).blocks[0]!.text);
    expect(cursor.mcpServers.morningpour).toEqual({
      url: IN.url,
      headers: { Authorization: 'Bearer lmsk_abc' },
    });
    const vscode = JSON.parse(agentSnippet('vscode', IN).blocks[0]!.text);
    expect(vscode.mcpServers.morningpour.type).toBe('http');
  });

  it('Grok: URL, cabecera y comando de Grok Build', () => {
    const blocks = agentSnippet('grok', IN).blocks.map((b) => b.text);
    expect(blocks).toEqual([
      IN.url,
      'Authorization: Bearer lmsk_abc',
      'grok mcp add --transport http morningpour https://morningpour.didacta.io/api/v1/mcp --header "Authorization: Bearer lmsk_abc"',
    ]);
  });

  it('los enlaces a las guías de un agente nunca dicen lo mismo dos veces', () => {
    for (const id of AGENT_IDS) {
      const { docs } = agentSnippet(id, IN);
      const labels = docs.map((d) => docsLabel(d, docs));
      expect(new Set(labels).size).toBe(docs.length);
    }
    const grok = agentSnippet('grok', IN).docs;
    expect(grok.map((d) => docsLabel(d, grok))).toEqual(['docs.x.ai/grok-bot', 'docs.x.ai/build']);
    // Con dominio propio, solo el dominio (sin «www.»).
    expect(
      docsLabel('https://www.cursor.com/docs/context/mcp', [
        'https://www.cursor.com/docs/context/mcp',
      ]),
    ).toBe('cursor.com');
    const codex = agentSnippet('codex', IN).docs;
    expect(codex.map((d) => docsLabel(d, codex))).toEqual([
      'developers.openai.com',
      'learn.chatgpt.com',
    ]);
  });

  it('todos llevan la URL del aula, la clave y una guía oficial https', () => {
    for (const id of AGENT_IDS) {
      const s = agentSnippet(id, IN);
      const all = s.blocks.map((b) => b.text).join('\n');
      expect(all).toContain(IN.url);
      expect(all).toContain('lmsk_abc');
      expect(s.docs.length).toBeGreaterThan(0);
      expect(s.docs.every((d) => d.startsWith('https://'))).toBe(true);
    }
  });
});

describe('apoyo', () => {
  it('URL del MCP en el dominio del aula', () => {
    expect(mcpUrlFor('https://morningpour.didacta.io/')).toBe(IN.url);
  });

  it('nombre de la conexión a partir del aula', () => {
    expect(serverNameFor('morningpour')).toBe('morningpour');
    expect(serverNameFor('Café Ñandú 2')).toBe('cafe-nandu-2');
    expect(serverNameFor('')).toBe('didacta');
    expect(serverNameFor(null)).toBe('didacta');
  });

  it('clave de agente = algún scope agent:*', () => {
    expect(isAgentKey(['agent:courses:read'])).toBe(true);
    expect(isAgentKey(['enrollments:write', 'courses:read'])).toBe(false);
  });

  it('plegado y pestaña: se recuerdan, y sin almacenamiento no rompe', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    expect(readCollapsed(storage)).toBe(false);
    writeCollapsed(storage, true);
    expect(readCollapsed(storage)).toBe(true);
    const roto = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
    };
    expect(readCollapsed(roto)).toBe(false);
    expect(() => writeCollapsed(roto, true)).not.toThrow();
    expect(readTab(roto)).toBe('claude-code');
    expect(readTab({ getItem: () => 'inventado' })).toBe('claude-code');
    expect(readTab({ getItem: () => 'codex' })).toBe('codex');
  });
});

describe('logos de los agentes', () => {
  const PUBLIC = path.resolve(__dirname, '../../public');

  it('cada pestaña tiene su logo, en el propio aula y con su nombre', () => {
    expect(Object.keys(AGENT_LOGOS).sort()).toEqual([...AGENT_IDS].sort());
    for (const id of AGENT_IDS) expect(AGENT_LOGOS[id]).toBe(`/agents/${id}.svg`);
    expect(new Set(Object.values(AGENT_LOGOS)).size).toBe(AGENT_IDS.length);
  });

  it.each(AGENT_IDS)('%s: SVG autocontenido que escala al tamaño de la pestaña', (id) => {
    const svg = readFileSync(path.join(PUBLIC, AGENT_LOGOS[id]), 'utf8');
    const root = /^<svg\s[^>]*>/.exec(svg.trim())?.[0] ?? '';
    // Escala por el viewBox: sin width/height fijos en la raíz.
    expect(root).toMatch(/viewBox="[\d.\s-]+"/);
    expect(root).not.toMatch(/\s(width|height)=/);
    // Nada que cargue de fuera ni que se ejecute (la CSP y el <img> lo cortarían).
    expect(svg).not.toMatch(/<script|<image|<foreignObject|href=|url\(\s*['"]?https?:/i);
    // Pinta algo: al menos un trazado con color.
    expect(svg).toMatch(/<path\s/);
    expect(svg).toMatch(/fill="#[0-9a-f]{3,6}"|fill:#[0-9a-f]{3,6}|fill="url\(#/i);
  });
});
