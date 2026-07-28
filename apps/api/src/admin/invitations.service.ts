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
 *  - **Activado**: `user.status = ACTIVE`. Un usuario invitado pasa a activo en
 *    cuanto define su contraseña y entra.
 *  - **Sin invitar**: usuario PENDING sin ningún token.
 *
 * Consecuencia útil: el envío por lotes es REANUDABLE por construcción. Si un
 * lote se corta a la mitad, el siguiente sigue donde se quedó y nadie recibe la
 * invitación dos veces.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminUsers: AdminUsersService,
    private readonly logger: PinoLogger,
  ) {}

  async summary(tenantId: string): Promise<InvitationsSummary> {
    const [totales, invitadosRows] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['status'],
        where: { tenantId, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<Array<{ status: string; total: bigint }>>`
        SELECT u.status::text AS status, COUNT(*)::bigint AS total
        FROM "user" u
        WHERE u.tenant_id = ${tenantId}::uuid
          AND u.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)
        GROUP BY u.status
      `,
    ]);

    const porEstado = (rows: Array<{ status: string; total: bigint }>) =>
      Object.fromEntries(rows.map((r) => [r.status, Number(r.total)]));
    const invitados = porEstado(invitadosRows);

    const total = totales.reduce((a, t) => a + t._count._all, 0);
    const activos = totales.find((t) => t.status === 'ACTIVE')?._count._all ?? 0;
    const pendientes = totales.find((t) => t.status === 'PENDING')?._count._all ?? 0;

    const invitadosTotal = Object.values(invitados).reduce((a, n) => a + n, 0);
    const invitadosActivados = invitados['ACTIVE'] ?? 0;

    return {
      total,
      activos,
      pendientes,
      invitados: invitadosTotal,
      // Solo cuenta como "convertido" quien fue invitado Y está activo: los
      // activos de antes de la campaña no inflan el resultado.
      activadosTrasInvitacion: invitadosActivados,
      sinInvitar: pendientes - (invitados['PENDING'] ?? 0),
      tasaConversion:
        invitadosTotal > 0 ? Math.round((invitadosActivados / invitadosTotal) * 100) : null,
    };
  }

  /**
   * Listado para el panel. `filtro`:
   *  - `invitados`  → ya recibieron la invitación (activados o no)
   *  - `activados`  → invitados que ya entraron
   *  - `sin-enviar` → pendientes a los que aún no se les ha escrito
   */
  async list(
    tenantId: string,
    opts: {
      filtro?: 'invitados' | 'activados' | 'sin-enviar';
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
      filtro === 'sin-enviar'
        ? `u.status = 'PENDING' AND NOT EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)`
        : filtro === 'activados'
          ? `u.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)`
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

    return {
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        status: r.status,
        invitedAt: r.invited_at ? r.invited_at.toISOString() : null,
        lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
        envios: Number(r.envios),
      })),
      total,
      page,
      limit,
      hasMore: offset + rows.length < total,
    };
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
            status: 'PENDING',
            email: { in: opts.emails.map((e) => e.trim().toLowerCase()) },
          },
          select: { id: true, email: true },
          take: size,
        })
      : await this.prisma.$queryRaw<Array<{ id: string; email: string }>>`
          SELECT u.id, u.email
          FROM "user" u
          WHERE u.tenant_id = ${tenantId}::uuid
            AND u.deleted_at IS NULL
            AND u.status = 'PENDING'
            AND NOT EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)
          ORDER BY u.created_at ASC
          LIMIT ${size}
        `;

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

    const restantes = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*)::bigint AS total
      FROM "user" u
      WHERE u.tenant_id = ${tenantId}::uuid
        AND u.deleted_at IS NULL
        AND u.status = 'PENDING'
        AND NOT EXISTS (SELECT 1 FROM password_reset_token t WHERE t.user_id = u.id)
    `;

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
  /** Porcentaje de invitados que ya entraron. Null si aún no se invitó a nadie. */
  tasaConversion: number | null;
}

export interface InvitationRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  invitedAt: string | null;
  lastLoginAt: string | null;
  /** Cuántas veces se le ha enviado (reenvíos incluidos). */
  envios: number;
}

export interface BatchResult {
  enviados: number;
  fallidos: Array<{ email: string; error: string }>;
  emails: string[];
  pendientesRestantes: number;
}
