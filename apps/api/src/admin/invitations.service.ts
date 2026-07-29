import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { AdminUsersService } from './admin-users.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminUsers: AdminUsersService,
    private readonly logger: PinoLogger,
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
  async sendBatch(
    tenantId: string,
    actorId: string,
    webBaseUrl: string,
    ctx: ClientContext,
    opts: { size?: number; emails?: string[]; pauseMs?: number },
  ): Promise<BatchResult> {
    const size = Math.min(200, Math.max(1, opts.size ?? 25));
    const pausa = Math.min(5000, Math.max(0, opts.pauseMs ?? 400));

    const destinatarios = opts.emails?.length
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

    const enviados: string[] = [];
    const fallidos: Array<{ email: string; error: string }> = [];

    for (const u of destinatarios) {
      try {
        await this.adminUsers.resendInvite(tenantId, actorId, u.id, webBaseUrl, ctx);
        enviados.push(u.email);
      } catch (err) {
        fallidos.push({ email: u.email, error: (err as Error).message ?? 'error' });
      }
      if (pausa > 0) await new Promise((r) => setTimeout(r, pausa));
    }

    this.logger.log(
      { tenantId, actorId, enviados: enviados.length, fallidos: fallidos.length },
      'invitaciones: lote enviado',
    );

    const restantes = await this.prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
      `
      SELECT COUNT(*)::bigint AS total
      FROM "user" u
      WHERE u.tenant_id = $1::uuid
        AND u.deleted_at IS NULL
        AND ${SIN_ENTRAR}
        AND NOT EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)
      `,
      tenantId,
    );

    return {
      enviados: enviados.length,
      fallidos,
      emails: enviados,
      pendientesRestantes: Number(restantes[0]?.total ?? 0),
    };
  }
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
