/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import { AgentKeyGuard } from './agent-key.guard';
import { AgentService, AgentToolError } from './agent.service';

/**
 * Servidor MCP del aula — transporte «Streamable HTTP» de la especificación
 * MCP, en su forma sin estado: cada POST lleva un mensaje JSON-RPC 2.0 y se
 * responde con `application/json`. No hay sesión (`Mcp-Session-Id`) ni flujo
 * SSE: las herramientas son petición/respuesta y no hay nada que empujar.
 *
 *   - `initialize` → negocia versión y saluda con el nombre del aula.
 *   - `tools/list` → SOLO las herramientas de los scopes de la clave y de los
 *     módulos activos del aula: el agente nunca ve lo que se le va a negar.
 *   - `tools/call` → valida los argumentos con zod y llama al servicio del
 *     módulo; un fallo de la herramienta vuelve como `isError: true` para que
 *     el agente lo lea (no como error de protocolo).
 *   - Notificaciones (sin `id`) → 202 sin cuerpo, como pide el transporte.
 *   - GET / DELETE → 405: no se ofrece flujo SSE ni sesiones que cerrar.
 *
 * Probado con clientes reales (Claude Code 2.1, Codex 0.154 y el cliente
 * oficial `@modelcontextprotocol/sdk` 1.32, que negocia 2025-11-25). El
 * recorrido de punta a punta está en `apps/e2e/tests/agente-ia-panel.spec.ts`.
 * No exige la cabecera `MCP-Protocol-Version`: hay clientes que no la mandan
 * al reutilizar la sesión y un servidor estricto les respondía 400.
 */

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** Versiones del protocolo que este servidor habla, de la más nueva a la más vieja. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_VERSION = '1.0.0';

function isRequestId(id: unknown): id is string | number {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && MCP_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSIONS[0]!;
}

@ApiTags('Agentes')
@ApiSecurity('ApiKey')
@Controller('mcp')
@UseGuards(AgentKeyGuard)
export class McpController {
  constructor(private readonly agent: AgentService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Servidor MCP del aula (Streamable HTTP, JSON-RPC 2.0). Autenticación: Authorization: Bearer lmsk_… de una clave con scopes agent:*.',
  })
  async rpc(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<unknown> {
    const user = req.user;
    const apiKeyId = req.agentKey?.apiKeyId;
    if (!user || !apiKeyId) throw new UnauthorizedException();

    // El contexto de tenant ya lo abrió TenantMiddleware con esta misma clave
    // (el guard lo ha comprobado). Se abre otra vez aquí, explícito, para que
    // ninguna consulta de una herramienta pueda correr fuera del aula de la
    // clave aunque mañana cambie el orden de los middlewares.
    return runAsTenant(
      user.tenantId,
      async () => {
        // Lotes (especificación 2025-03-26): se aceptan por compatibilidad.
        if (Array.isArray(body)) {
          if (body.length === 0) return this.error(null, -32600, 'Empty batch');
          const out: unknown[] = [];
          for (const msg of body) {
            const r = await this.handle(req, msg);
            if (r !== undefined) out.push(r);
          }
          if (out.length === 0) {
            reply.status(202);
            return undefined;
          }
          return out;
        }
        const r = await this.handle(req, body);
        if (r === undefined) {
          reply.status(202);
          return undefined;
        }
        return r;
      },
      { userId: user.sub, traceLabel: 'mcp' },
    );
  }

  /** Sin flujo SSE: el transporte permite responder 405 a GET. */
  @Get()
  @ApiExcludeEndpoint()
  noStream(@Res() reply: FastifyReply): void {
    void reply.status(405).header('Allow', 'POST').send();
  }

  /** Sin sesiones que cerrar: 405 a DELETE, igual que a GET. */
  @Delete()
  @ApiExcludeEndpoint()
  noSession(@Res() reply: FastifyReply): void {
    void reply.status(405).header('Allow', 'POST').send();
  }

  // ── Interno ────────────────────────────────────────────────────────────────

  private async handle(req: FastifyRequest, raw: unknown): Promise<unknown> {
    const msg = (raw ?? {}) as JsonRpcMessage;
    if (typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // Una respuesta del cliente (sin method) no pide nada a cambio.
      if (msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && !('method' in msg)) {
        return undefined;
      }
      return this.error(isRequestId(msg?.id) ? msg.id : null, -32600, 'Invalid JSON-RPC request');
    }

    // Notificación: no lleva id y no tiene respuesta.
    if (!isRequestId(msg.id)) return undefined;
    const id = msg.id;
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<
      string,
      unknown
    >;
    const user = req.user!;

    switch (msg.method) {
      case 'initialize': {
        const name = await this.agent.academyName(user.tenantId);
        return this.ok(id, {
          protocolVersion: negotiateProtocolVersion(params['protocolVersion']),
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: 'didacta',
            title: name ? `Didacta · ${name}` : 'Didacta',
            version: SERVER_VERSION,
          },
          instructions: [
            `You are connected to the online academy "${name ?? 'Didacta'}".`,
            'You can create and edit courses and lessons, schedule live classes and post in the community, on behalf of the academy owner.',
            'Everything you create stays as a draft: the owner publishes it (with its price) from "Start here".',
            'You cannot publish, set prices, delete anything, invite people or email the members.',
            'Write the content in the language the owner uses with you.',
          ].join(' '),
        });
      }

      case 'ping':
        return this.ok(id, {});

      case 'tools/list': {
        const tools = await this.agent.visibleTools(user);
        return this.ok(id, {
          tools: tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: {
              title: t.title,
              readOnlyHint: !t.writes,
              destructiveHint: false,
              idempotentHint: !t.writes,
              openWorldHint: false,
            },
          })),
        });
      }

      case 'tools/call': {
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        try {
          const result = await this.agent.call(
            user,
            req.agentKey!.apiKeyId,
            name,
            params['arguments'],
          );
          return this.ok(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          const e =
            err instanceof AgentToolError
              ? err
              : new AgentToolError('AGENT_INTERNAL', 'Unexpected error. Try again in a moment.');
          return this.ok(id, {
            isError: true,
            content: [{ type: 'text', text: `${e.message} (${e.code})` }],
          });
        }
      }

      // Sin recursos ni prompts en v1: listas vacías en vez de «método no
      // soportado», que algunos clientes muestran como un fallo del servidor.
      case 'resources/list':
        return this.ok(id, { resources: [] });
      case 'resources/templates/list':
        return this.ok(id, { resourceTemplates: [] });
      case 'prompts/list':
        return this.ok(id, { prompts: [] });

      default:
        return this.error(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  private ok(id: string | number, result: unknown) {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: string | number | null, code: number, message: string) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
