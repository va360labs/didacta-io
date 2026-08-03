/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { AdminUsersService } from './admin-users.service';
import { AccessGroupsService } from '../modules/access-groups/access-groups.service';
import type { ClientContext } from '../auth/client-context';

/**
 * Seguimiento de las invitaciones al aula: a quién se le ha enviado, quién ha
 * acabado entrando y a quién le falta.
 *
 * De dónde sale cada dato, que es lo que hace fiable el panel sin tener que
 * llevar una lista aparte:
 *  - **Invitado**: el envío crea un token de restablecimiento. El más ANTIGUO de
 *    cada usuario es la fecha en que se le invitó por primera vez.
 *  - **Ya entró**: `user.last_login_at IS NOT NULL`. Es el hecho, no una
 *    intención: la persona abrió el enlace, definió contraseña y usó el aula.
 *  - **Sin invitar**: alguien que aún no ha entrado y no tiene ningún token.
 *
 * Antes esto se leía de `user.status` (PENDING = por entrar, ACTIVE = entró),
 * y dejó de valer cuando las altas pasaron a crearse ACTIVE — el status nunca
 * fue prueba de que nadie hubiese entrado, solo lo parecía porque el alta lo
 * dejaba en PENDING. `last_login_at` responde exactamente a la pregunta del
 * panel y funciona igual para las cuentas de antes y las de después.
 *
 * Consecuencia útil: el envío por lotes es REANUDABLE por construcción. Si un
 * lote se corta a la mitad, el siguiente sigue donde se quedó y nadie recibe la
 * invitación dos veces.
 */

/** Quien todavía no ha entrado nunca (y no está suspendido ni desactivado). */
const SIN_ENTRAR = `u.last_login_at IS NULL AND u.status NOT IN ('SUSPENDED', 'DEACTIVATED')`;

@Injectable()
export class InvitationsService {
  /**
   * Progreso del envío por tenant. En memoria a propósito: es estado de una
   * operación en vuelo, no un dato del producto. Con más de una instancia de
   * API habría que moverlo a Redis — hoy sirve una sola.
   */
  private readonly envios = new Map<string, EnvioEstado>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminUsers: AdminUsersService,
    private readonly logger: PinoLogger,
    // Mismo patrón que AdminUsersService.invite()/startBulkInvite(): el core
    // llama al service del módulo first-party, nunca a sus tablas.
    private readonly accessGroups: AccessGroupsService,
  ) {}

  async summary(tenantId: string): Promise<InvitationsSummary> {
    const [totales, invitadosRows, sinInvitarRows, sinAccesoRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ entrado: boolean; total: bigint }>>(
        `
        SELECT (u.last_login_at IS NOT NULL) AS entrado, COUNT(*)::bigint AS total
        FROM "user" u
        WHERE u.tenant_id = $1::uuid
          AND u.deleted_at IS NULL
          AND (u.last_login_at IS NOT NULL OR (${SIN_ENTRAR}))
        GROUP BY 1
        `,
        tenantId,
      ),
      this.prisma.$queryRawUnsafe<Array<{ entrado: boolean; total: bigint }>>(
        `
        SELECT (u.last_login_at IS NOT NULL) AS entrado, COUNT(*)::bigint AS total
        FROM "user" u
        WHERE u.tenant_id = $1::uuid
          AND u.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)
        GROUP BY 1
        `,
        tenantId,
      ),
      // Mismo predicado EXACTO que el filtro `sin-enviar` y que la selección de
      // `sendBatch`: el contador tiene que decir lo que el botón va a hacer, y
      // restar dos agregados con cohortes distintas (p. ej. un suspendido que sí
      // tiene token) lo descuadraba por unos pocos.
      this.prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
        `
        SELECT COUNT(*)::bigint AS total
        FROM "user" u
        WHERE u.tenant_id = $1::uuid
          AND u.deleted_at IS NULL
          AND ${SIN_ENTRAR}
          AND NOT EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)
        `,
        tenantId,
      ),
      this.prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
        `
        SELECT COUNT(*)::bigint AS total
        FROM "user" u
        WHERE u.tenant_id = $1::uuid
          AND u.deleted_at IS NULL
          AND ${SIN_ENTRAR}
          AND NOT EXISTS (
            SELECT 1 FROM mod_access_groups_group_member m
            WHERE m.user_id = u.id AND m.status = 'ACTIVE'
          )
        `,
        tenantId,
      ),
    ]);

    const contar = (rows: Array<{ entrado: boolean; total: bigint }>, entrado: boolean) =>
      Number(rows.find((r) => r.entrado === entrado)?.total ?? 0);

    const activos = contar(totales, true);
    const pendientes = contar(totales, false);
    const invitadosActivados = contar(invitadosRows, true);
    const invitadosTotal = invitadosActivados + contar(invitadosRows, false);

    return {
      total: activos + pendientes,
      activos,
      pendientes,
      invitados: invitadosTotal,
      // Solo cuenta como "convertido" quien fue invitado Y ya entró: los que
      // entraban antes de la campaña no inflan el resultado.
      activadosTrasInvitacion: invitadosActivados,
      sinInvitar: Number(sinInvitarRows[0]?.total ?? 0),
      pendientesSinAcceso: Number(sinAccesoRows[0]?.total ?? 0),
      tasaConversion:
        invitadosTotal > 0 ? Math.round((invitadosActivados / invitadosTotal) * 100) : null,
      // El envío por lotes corre en segundo plano: el panel lee su progreso de
      // aquí (ya pide el summary) en vez de esperar a que termine la petición.
      envio: this.envios.get(tenantId) ?? null,
    };
  }

  /**
   * Listado para el panel. `filtro`:
   *  - `invitados`  → ya recibieron la invitación (activados o no)
   *  - `activados`  → invitados que ya entraron
   *  - `sin-enviar` → pendientes a los que aún no se les ha escrito
   *  - `sin-acceso` → pendientes que no están en NINGÚN grupo: si se les invita
   *    entrarían a un aula vacía, así que conviene revisarlos antes de escribir
   */
  async list(
    tenantId: string,
    opts: {
      filtro?: 'invitados' | 'activados' | 'sin-enviar' | 'sin-acceso';
      search?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{
    items: InvitationRow[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * limit;
    const filtro = opts.filtro ?? 'invitados';
    const search = opts.search?.trim() ? `%${opts.search.trim().toLowerCase()}%` : null;

    // El WHERE cambia con el filtro; se construye con fragmentos parametrizados
    // (nunca interpolando el término de búsqueda) para no abrir un inyectable.
    const condicionFiltro =
      filtro === 'sin-acceso'
        ? `${SIN_ENTRAR} AND NOT EXISTS (SELECT 1 FROM mod_access_groups_group_member m WHERE m.user_id = u.id AND m.status = 'ACTIVE')`
        : filtro === 'sin-enviar'
          ? `${SIN_ENTRAR} AND NOT EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)`
          : filtro === 'activados'
            ? `u.last_login_at IS NOT NULL AND EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)`
            : `EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)`;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        email: string;
        name: string | null;
        status: string;
        invited_at: Date | null;
        last_login_at: Date | null;
        envios: bigint;
      }>
    >(
      `
      SELECT u.id, u.email, u.name, u.status::text AS status,
             (SELECT MIN(t.created_at) FROM password_reset_token t WHERE t.user_id = u.id) AS invited_at,
             u.last_login_at,
             (SELECT COUNT(*) FROM password_reset_token t WHERE t.user_id = u.id)::bigint AS envios
      FROM "user" u
      WHERE u.tenant_id = $1::uuid AND u.deleted_at IS NULL
        AND ${condicionFiltro}
        AND ($2::text IS NULL OR LOWER(u.email) LIKE $2 OR LOWER(COALESCE(u.name,'')) LIKE $2)
      ORDER BY invited_at DESC NULLS LAST, u.email ASC
      LIMIT $3 OFFSET $4
      `,
      tenantId,
      search,
      limit,
      offset,
    );

    const totalRows = await this.prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
      `
      SELECT COUNT(*)::bigint AS total
      FROM "user" u
      WHERE u.tenant_id = $1::uuid AND u.deleted_at IS NULL
        AND ${condicionFiltro}
        AND ($2::text IS NULL OR LOWER(u.email) LIKE $2 OR LOWER(COALESCE(u.name,'')) LIKE $2)
      `,
      tenantId,
      search,
    );
    const total = Number(totalRows[0]?.total ?? 0);

    // Los grupos se piden aparte para los usuarios de ESTA página: agregarlos en
    // la consulta principal obligaría a un GROUP BY sobre toda la tabla.
    const grupos = await this.gruposDe(
      tenantId,
      rows.map((r) => r.id),
    );

    return {
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        status: r.status,
        entrado: r.last_login_at !== null,
        invitedAt: r.invited_at ? r.invited_at.toISOString() : null,
        lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
        envios: Number(r.envios),
        grupos: grupos.get(r.id) ?? [],
      })),
      total,
      page,
      limit,
      hasMore: offset + rows.length < total,
    };
  }

  /**
   * Grupos de acceso ACTIVOS de cada usuario. Es la respuesta a "¿qué va a ver
   * esta persona cuando entre?", que es justo lo que hay que revisar ANTES de
   * escribirle: invitar a alguien que entraría a un aula vacía es peor que no
   * invitarle.
   */
  private async gruposDe(tenantId: string, userIds: string[]): Promise<Map<string, string[]>> {
    if (userIds.length === 0) return new Map();
    const filas = await this.prisma.modAccessGroupMember.findMany({
      where: { tenantId, status: 'ACTIVE', userId: { in: userIds } },
      select: { userId: true, group: { select: { name: true, deletedAt: true } } },
    });
    const mapa = new Map<string, string[]>();
    for (const f of filas) {
      if (f.group.deletedAt) continue;
      const actual = mapa.get(f.userId) ?? [];
      actual.push(f.group.name);
      mapa.set(f.userId, actual);
    }
    for (const [k, v] of mapa)
      mapa.set(
        k,
        v.sort((a, b) => a.localeCompare(b)),
      );
    return mapa;
  }

  /**
   * Envía la invitación al siguiente lote de pendientes que aún no la han
   * recibido. Va de uno en uno y con una pausa entre correos: un envío masivo
   * de golpe es la forma más rápida de que el dominio acabe marcado como spam.
   *
   * `emails` permite fijar exactamente a quién escribir (para priorizar, por
   * ejemplo, a los clientes de pago). Sin esa lista se toman los más antiguos.
   */
  /**
   * Arranca el envío del siguiente lote y **vuelve enseguida**, sin esperar a
   * que termine.
   *
   * Por qué no es síncrono: cada correo tarda ~1 s (envío + pausa
   * anti-spam), así que un lote de 150 son ~3 minutos y el proxy corta la
   * petición a los 30 s. El lote se enviaba entero igual — el bucle seguía en
   * segundo plano — pero el panel enseñaba "No se pudo enviar el lote" sobre
   * un envío que había funcionado. Mentir así en una campaña de un solo
   * disparo por destinatario es peor que no informar.
   *
   * El progreso se consulta en `summary().envio`. Si el contenedor se reinicia
   * a mitad, los que queden sin token los recoge el lote siguiente: el envío
   * es reanudable por construcción.
   *
   * `opts.accessGroupId` (opcional): además de invitar, añade a cada
   * destinatario del lote a ese grupo de acceso (mismo `assignMembers` que usa
   * `AdminUsersService.invite()`/`startBulkInvite()` — aditivo, no toca los
   * grupos que ya tuviera). Pensado para el cohort "sin ningún curso
   * asignado": sin esto, un lote entraría a un aula vacía y habría que
   * arreglarlo persona por persona desde `/admin/grupos-acceso`.
   */
  async startBatch(
    tenantId: string,
    actorId: string,
    webBaseUrl: string,
    ctx: ClientContext,
    opts: { size?: number; emails?: string[]; pauseMs?: number; accessGroupId?: string },
  ): Promise<{ aceptado: boolean; yaEnCurso: boolean; total: number }> {
    const enCurso = this.envios.get(tenantId);
    if (enCurso?.enCurso) {
      // Segundo click (o segundo admin) mientras uno corre: no arrancamos otro
      // bucle. Dos a la vez seleccionarían los mismos pendientes en la ventana
      // entre el SELECT y la creación del token, y alguien recibiría dos correos.
      return { aceptado: false, yaEnCurso: true, total: enCurso.total };
    }

    // Un grupo inválido (o de otro tenant) aborta ANTES de seleccionar
    // destinatarios, no a mitad del lote. Mismo criterio fail-closed que
    // `AdminUsersService.invite()`.
    if (opts.accessGroupId) {
      await this.accessGroups.getGroup(tenantId, opts.accessGroupId);
    }

    const destinatarios = await this.seleccionarPendientes(tenantId, opts);
    const ahora = new Date().toISOString();
    this.envios.set(tenantId, {
      enCurso: destinatarios.length > 0,
      total: destinatarios.length,
      enviados: 0,
      fallidos: [],
      iniciadoEn: ahora,
      terminadoEn: destinatarios.length > 0 ? null : ahora,
    });

    if (destinatarios.length > 0) {
      void this.enviarEnSegundoPlano(tenantId, actorId, webBaseUrl, ctx, destinatarios, opts);
    }
    return { aceptado: true, yaEnCurso: false, total: destinatarios.length };
  }

  /** Estado del envío en curso (o del último), para que el panel lo pinte. */
  estadoEnvio(tenantId: string): EnvioEstado | null {
    return this.envios.get(tenantId) ?? null;
  }

  private async seleccionarPendientes(
    tenantId: string,
    opts: { size?: number; emails?: string[] },
  ): Promise<Array<{ id: string; email: string }>> {
    const size = Math.min(200, Math.max(1, opts.size ?? 25));

    return opts.emails?.length
      ? await this.prisma.user.findMany({
          where: {
            tenantId,
            deletedAt: null,
            lastLoginAt: null,
            status: { notIn: ['SUSPENDED', 'DEACTIVATED'] },
            email: { in: opts.emails.map((e) => e.trim().toLowerCase()) },
          },
          select: { id: true, email: true },
          take: size,
        })
      : await this.prisma.$queryRawUnsafe<Array<{ id: string; email: string }>>(
          `
          SELECT u.id, u.email
          FROM "user" u
          WHERE u.tenant_id = $1::uuid
            AND u.deleted_at IS NULL
            AND ${SIN_ENTRAR}
            AND NOT EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)
          ORDER BY u.created_at ASC
          LIMIT $2
          `,
          tenantId,
          size,
        );
  }

  /**
   * El bucle real. Corre desligado de la petición HTTP, así que NO puede
   * lanzar: cualquier excepción aquí sería un unhandled rejection. Todo va
   * dentro de try/catch y el estado siempre acaba con `enCurso: false`, o el
   * panel se quedaría diciendo "enviando…" para siempre.
   */
  private async enviarEnSegundoPlano(
    tenantId: string,
    actorId: string,
    webBaseUrl: string,
    ctx: ClientContext,
    destinatarios: Array<{ id: string; email: string }>,
    opts: { pauseMs?: number; accessGroupId?: string },
  ): Promise<void> {
    const pausa = Math.min(5000, Math.max(0, opts.pauseMs ?? 400));
    const estado = this.envios.get(tenantId);

    try {
      for (const u of destinatarios) {
        try {
          // Añadir al grupo es fail-soft (como en `invite()`): si falla, el
          // envío del correo sigue igual — mejor una invitación sin grupo
          // asignado que ninguna, y el operador lo corrige desde el panel de
          // grupos.
          if (opts.accessGroupId) {
            try {
              await this.accessGroups.assignMembers(tenantId, opts.accessGroupId, [u.id]);
            } catch (err) {
              this.logger.warn(
                { err, userId: u.id, accessGroupId: opts.accessGroupId },
                'invitaciones: no se pudo añadir al grupo de acceso; se envía la invitación igual',
              );
            }
          }
          await this.adminUsers.resendInvite(tenantId, actorId, u.id, webBaseUrl, ctx);
          if (estado) estado.enviados += 1;
        } catch (err) {
          if (estado) {
            estado.fallidos.push({ email: u.email, error: (err as Error).message ?? 'error' });
          }
        }
        if (pausa > 0) await new Promise((r) => setTimeout(r, pausa));
      }
    } catch (err) {
      this.logger.error(
        { tenantId, err: err instanceof Error ? err.message : String(err) },
        'invitaciones: el lote se cortó por un error inesperado',
      );
    } finally {
      if (estado) {
        estado.enCurso = false;
        estado.terminadoEn = new Date().toISOString();
      }
      this.logger.log(
        {
          tenantId,
          actorId,
          enviados: estado?.enviados ?? 0,
          fallidos: estado?.fallidos.length ?? 0,
        },
        'invitaciones: lote enviado',
      );
    }
  }
}

/** Progreso del envío por lotes. En memoria: sobrevive a la petición, no al
 *  reinicio del contenedor — y no hace falta que sobreviva, porque quien se
 *  quede sin token lo recoge el lote siguiente. */
export interface EnvioEstado {
  enCurso: boolean;
  total: number;
  enviados: number;
  fallidos: Array<{ email: string; error: string }>;
  iniciadoEn: string;
  terminadoEn: string | null;
}

export interface InvitationsSummary {
  total: number;
  activos: number;
  pendientes: number;
  invitados: number;
  activadosTrasInvitacion: number;
  sinInvitar: number;
  /** Pendientes que no están en ningún grupo: entrarían a un aula vacía. */
  pendientesSinAcceso: number;
  /** Porcentaje de invitados que ya entraron. Null si aún no se invitó a nadie. */
  tasaConversion: number | null;
  /** Envío por lotes en curso (o el último terminado). Null si nunca se lanzó. */
  envio: EnvioEstado | null;
}

export interface InvitationRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  /** True si ya usó el aula alguna vez. Es lo que la tabla pinta como "Ya entró". */
  entrado: boolean;
  invitedAt: string | null;
  lastLoginAt: string | null;
  /** Cuántas veces se le ha enviado (reenvíos incluidos). */
  envios: number;
  /** Grupos de acceso a los que pertenece: lo que verá al entrar. */
  grupos: string[];
}

export interface BatchResult {
  enviados: number;
  fallidos: Array<{ email: string; error: string }>;
  emails: string[];
  pendientesRestantes: number;
}
