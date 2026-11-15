/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import { eventIdempotencyKey, type ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import { CAPTURA_MAX_BYTES, extensionDe, validarCaptura, type CapturaInput } from './captura.js';
import {
  LimiteDiarioError,
  SinPermisoError,
  TextoInvalidoError,
  TicketNoEncontradoError,
} from './errors.js';

/**
 * mod.soporte — «Ayuda y sugerencias».
 *
 * Un miembro envía un ticket (algo no funciona, tengo un problema o una
 * sugerencia) con una captura opcional y el contexto de la pantalla en la que
 * estaba. Ve solo los suyos y su estado, nunca la nota interna. Quien
 * administra el aula los ve todos, cambia el estado y escribe una nota
 * interna.
 *
 * Toda la lógica vive aquí; el controller del host solo resuelve quién llama.
 * Módulo nuevo (ADR-039): no lee ni escribe tablas de otros módulos. El host
 * le pasa:
 *   - `AutorTicket` al crear (id y nombre, que se guarda como copia);
 *   - `Caller` en cada lectura (id y si administra el aula);
 *   - `SoportePorts`: quién administra el aula, el almacén de capturas, la
 *     dirección pública del aula, el aviso al operador de la plataforma y cómo
 *     correr los avisos en segundo plano.
 * Cada consulta filtra por `tenantId`.
 *
 * Diferencias con Community (VA360), que es de donde viene:
 *   - Los avisos (campana y correo al equipo, correo al operador, aviso al
 *     autor de un cambio de estado) salen JUSTO DESPUÉS de responder, en
 *     segundo plano: un SMTP lento ya no deja al miembro en «Enviando…» (y
 *     tentado de reenviar, duplicando el ticket). Un fallo de correo nunca
 *     deshace ni bloquea nada.
 *   - Los avisos no llevan texto en español: el tipo y el estado viajan como
 *     marcas (`esFallo`, `estadoResuelto`…) y cada plantilla del hub (es, en,
 *     pt) pone su frase. El idioma lo decide el hub por destinatario.
 *   - Aviso inmediato al operador de la plataforma (Didacta Cloud) de cada
 *     ticket nuevo, si el host lo cablea (`avisarOperador`).
 */

export const TIPOS_TICKET = ['FALLO', 'PROBLEMA', 'MEJORA'] as const;
export type TipoTicket = (typeof TIPOS_TICKET)[number];

export const ESTADOS_TICKET = ['NUEVO', 'EN_CURSO', 'RESUELTO', 'DESCARTADO'] as const;
export type EstadoTicket = (typeof ESTADOS_TICKET)[number];

/** Estados que cierran el ticket (ponen `closedAt`). */
export const ESTADOS_CERRADOS: readonly EstadoTicket[] = ['RESUELTO', 'DESCARTADO'];

export const LIMITES = {
  textoMin: 5,
  textoMax: 4000,
  notaInterna: 4000,
  contextoUrl: 500,
  contextoUserAgent: 500,
  contextoViewport: 20,
  capturaBytes: CAPTURA_MAX_BYTES,
  /** Tickets por persona en 24 horas móviles. */
  ticketsPorDia: 5,
  /** Tickets que devuelve como mucho la lista del equipo. */
  listaAdmin: 200,
  /** Caracteres del texto que van en el aviso al equipo. */
  extracto: 140,
} as const;

/** Plantillas del NotificationHub; su texto (es, en, pt) vive en el catálogo del host. */
export const PLANTILLA_TICKET_NUEVO = 'soporte.ticket.nuevo';
export const PLANTILLA_TICKET_ESTADO = 'soporte.ticket.estado';

/** Rutas de la web (ADR-060: en inglés). El aviso de la campana las usa por `ticketId`. */
export const RUTA_BANDEJA = '/admin/support';
export const RUTA_MIS_TICKETS = '/support';

const DIA_MS = 24 * 3600 * 1000;

/** Marca de cada tipo para las secciones `{{#esFallo}}…{{/esFallo}}` de las plantillas. */
const MARCA_TIPO: Readonly<Record<TipoTicket, string>> = {
  FALLO: 'esFallo',
  PROBLEMA: 'esProblema',
  MEJORA: 'esMejora',
};

/** Marca de cada estado para las secciones `{{#estadoResuelto}}…` de las plantillas. */
const MARCA_ESTADO: Readonly<Record<EstadoTicket, string>> = {
  NUEVO: 'estadoNuevo',
  EN_CURSO: 'estadoEnCurso',
  RESUELTO: 'estadoResuelto',
  DESCARTADO: 'estadoDescartado',
};

export interface AutorTicket {
  id: string;
  /** Nombre de la cuenta (nunca el email); lo resuelve el host. Puede venir vacío. */
  nombre: string;
}

export interface Caller {
  id: string;
  /** Administra el aula (roles super_admin o tenant_admin); lo decide el host. */
  esAdmin: boolean;
}

export interface ContextoInput {
  url?: string | null;
  userAgent?: string | null;
  viewport?: string | null;
  /** Momento en que se abrió el formulario, ISO 8601. */
  at?: string | null;
}

export interface TicketInput {
  tipo: TipoTicket;
  texto: string;
  contexto?: ContextoInput | null;
  captura?: CapturaInput | null;
}

export interface TicketView {
  id: string;
  tipo: TipoTicket;
  texto: string;
  estado: EstadoTicket;
  tieneCaptura: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface AdminTicketView extends TicketView {
  autorId: string;
  autorNombre: string;
  contexto: {
    url: string | null;
    userAgent: string | null;
    viewport: string | null;
    at: string | null;
  };
  notaInterna: string | null;
}

export interface AdminFiltros {
  estado?: EstadoTicket;
  tipo?: TipoTicket;
}

export interface AdminListado {
  items: AdminTicketView[];
  /** Tickets del aula por estado, sin aplicar los filtros. */
  counts: Record<EstadoTicket, number>;
}

export interface CambiosAdmin {
  estado?: EstadoTicket;
  /** `null` o vacía la borra. */
  notaInterna?: string | null;
}

export interface CapturaArchivo {
  data: Buffer;
  contentType: string;
  nombre: string;
}

/** Almacén de capturas con el storage de cada aula (lo da el host). */
export interface SoporteCapturaStorage {
  /** Guarda una imagen optimizándola; devuelve la clave y el tipo REALES. */
  putImage(
    tenantId: string,
    key: string,
    data: Buffer,
    contentType: string,
  ): Promise<{ key: string; contentType: string; size: number }>;
  get(tenantId: string, key: string): Promise<Buffer>;
}

/** Lo que el operador de la plataforma recibe de cada ticket nuevo. */
export interface AvisoOperadorTicket {
  tenantId: string;
  ticketId: string;
  tipo: TipoTicket;
  /** El texto ENTERO, no el extracto. */
  texto: string;
  autorId: string;
  autorNombre: string;
  tieneCaptura: boolean;
  createdAt: Date;
}

/** Lo que el host resuelve por el módulo, que no lee tablas core (ADR-039). */
export interface SoportePorts {
  /** Ids de las cuentas activas que administran el aula (super_admin, tenant_admin). */
  adminIds(tenantId: string): Promise<string[]>;
  /** Sin storage, los tickets se guardan sin captura. */
  storage?: SoporteCapturaStorage | null;
  /**
   * Dirección pública del aula (`https://academia.didacta.io`, sin barra
   * final), para el enlace directo de los correos. `''` o sin puerto: los
   * correos van sin ese enlace (la campana enlaza igual por `ticketId`).
   */
  webBaseUrl?(tenantId: string): Promise<string>;
  /**
   * Aviso inmediato al operador de la plataforma de cada ticket nuevo (Didacta
   * Cloud). Sin puerto, nadie de fuera del aula se entera. Si falla, el
   * módulo lo deja en el log con nivel de error y el ticket sigue guardado.
   */
  avisarOperador?(aviso: AvisoOperadorTicket): Promise<void>;
  /**
   * Corre los avisos de fondo con el contexto del aula (el host pone ahí la
   * RLS). Sin puerto se corren tal cual.
   */
  enSegundoPlano?(tenantId: string, tarea: () => Promise<void>): Promise<void>;
}

interface TicketRow {
  id: string;
  tenantId: string;
  autorId: string;
  autorNombre: string;
  tipo: TipoTicket;
  texto: string;
  estado: EstadoTicket;
  contextoUrl: string | null;
  contextoUserAgent: string | null;
  contextoViewport: string | null;
  contextoAt: Date | null;
  capturaKey: string | null;
  capturaContentType: string | null;
  capturaNombre: string | null;
  capturaSize: number | null;
  notaInterna: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Validación (pura) ────────────────────────────────────────────────────────

/** Texto del ticket: recortado, de 5 a 4000 caracteres. */
export function validarTexto(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length < LIMITES.textoMin) throw new TextoInvalidoError('TEXTO_CORTO');
  if (s.length > LIMITES.textoMax) throw new TextoInvalidoError('TEXTO_LARGO');
  return s;
}

function validarTipo(raw: unknown): TipoTicket {
  if (!(TIPOS_TICKET as readonly unknown[]).includes(raw)) {
    throw new TextoInvalidoError('TIPO_INVALIDO');
  }
  return raw as TipoTicket;
}

/** Nota interna: recortada, hasta 4000 caracteres; vacía es `null`. */
function validarNota(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (s.length > LIMITES.notaInterna) throw new TextoInvalidoError('NOTA_LARGA');
  return s;
}

/**
 * El contexto lo rellena la web sola: si algo viene largo se recorta en vez de
 * rechazar el ticket, y una fecha que no se entiende se descarta.
 */
function recortar(raw: unknown, max: number): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s ? s.slice(0, max) : null;
}

function fechaContexto(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function extracto(texto: string): string {
  const linea = texto.replace(/\s+/g, ' ').trim();
  return linea.length > LIMITES.extracto ? `${linea.slice(0, LIMITES.extracto)}…` : linea;
}

/** Marcas de las secciones de la plantilla: solo la del tipo (o estado) va a `true`. */
export function marcasTipo(tipo: TipoTicket): Record<string, boolean> {
  return Object.fromEntries(TIPOS_TICKET.map((t) => [MARCA_TIPO[t], t === tipo]));
}

export function marcasEstado(estado: EstadoTicket): Record<string, boolean> {
  return Object.fromEntries(ESTADOS_TICKET.map((e) => [MARCA_ESTADO[e], e === estado]));
}

function mensaje(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sinBarraFinal(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

// ── Servicio ─────────────────────────────────────────────────────────────────

export class SoporteService {
  /** Avisos de fondo que todavía no han terminado (`esperarAvisos`). */
  private readonly pendientes = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ports: SoportePorts,
    /** Del contexto del módulo: avisos por el NotificationHub, log y bus. */
    private readonly ctx?: Pick<ModuleContext, 'notificationHub'> &
      Partial<Pick<ModuleContext, 'logger' | 'eventBus'>>,
  ) {}

  private get tickets() {
    return this.prisma.modSoporteTicket;
  }

  // ── Miembros ───────────────────────────────────────────────────────────────

  /**
   * Envía un ticket. Todo se comprueba antes de guardar nada: tipo, texto,
   * captura y el límite de 5 en 24 horas. Si guardar la captura falla, el
   * ticket se guarda sin ella (lo importante es que llegue). Responde en
   * cuanto el ticket está guardado; los avisos al equipo y al operador salen
   * justo después, en segundo plano, y nunca hacen fallar el envío.
   */
  async crear(
    tenantId: string,
    autor: AutorTicket,
    input: TicketInput,
    now: Date = new Date(),
  ): Promise<TicketView> {
    const tipo = validarTipo(input.tipo);
    const texto = validarTexto(input.texto);
    const captura = input.captura ? validarCaptura(input.captura) : null;

    const contexto = input.contexto ?? {};
    // Contar y crear en una transacción con un candado por persona y aula:
    // dos envíos a la vez de la misma persona esperan su turno, y el segundo
    // ya cuenta el primero. El candado se suelta solo al terminar la
    // transacción. La clave va ligada como parámetro, nunca pegada al SQL.
    const candado = `${tenantId}:${autor.id}`;
    let row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${candado}::text))`;
      const recientes = await tx.modSoporteTicket.count({
        where: {
          tenantId,
          autorId: autor.id,
          createdAt: { gte: new Date(now.getTime() - DIA_MS) },
        },
      });
      if (recientes >= LIMITES.ticketsPorDia) throw new LimiteDiarioError(LIMITES.ticketsPorDia);
      return (await tx.modSoporteTicket.create({
        data: {
          id: randomUUID(),
          tenantId,
          autorId: autor.id,
          // Sin nombre se guarda vacío (no «Miembro» en español): la web y
          // las plantillas ponen la palabra en el idioma de quien lo lee.
          autorNombre: autor.nombre.trim(),
          tipo,
          texto,
          estado: 'NUEVO',
          contextoUrl: recortar(contexto.url, LIMITES.contextoUrl),
          contextoUserAgent: recortar(contexto.userAgent, LIMITES.contextoUserAgent),
          contextoViewport: recortar(contexto.viewport, LIMITES.contextoViewport),
          contextoAt: fechaContexto(contexto.at),
          createdAt: now,
        },
      })) as TicketRow;
    });

    // La captura, solo con el ticket ya guardado: si el límite lo rechaza no
    // se sube nada, y nunca queda un archivo sin ticket. Si falla, el ticket
    // se queda sin ella (lo importante es que llegue).
    if (captura) row = await this.adjuntarCaptura(row, captura);

    await this.publish(tenantId, autor.id, 'soporte.ticket.created', {
      ticketId: row.id,
      autorId: row.autorId,
      tipo: row.tipo,
    });
    const guardado = row;
    this.lanzar(tenantId, 'ticket nuevo', () => this.avisarTicketNuevo(guardado));
    return vista(row);
  }

  /** Mis tickets, del más nuevo al más antiguo. Sin nota interna ni contexto. */
  async mios(tenantId: string, userId: string): Promise<TicketView[]> {
    const rows = (await this.tickets.findMany({
      where: { tenantId, autorId: userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIMITES.listaAdmin,
    })) as TicketRow[];
    return rows.map(vista);
  }

  /**
   * La captura de un ticket, para su autor o quien administra el aula. A
   * cualquier otro, o si no hay captura, «no encontrado»: no se dice que existe.
   */
  async captura(tenantId: string, caller: Caller, ticketId: string): Promise<CapturaArchivo> {
    const row = await this.cargar(tenantId, ticketId);
    if (!caller.esAdmin && row.autorId !== caller.id) throw new TicketNoEncontradoError();
    const storage = this.ports.storage;
    if (!row.capturaKey || !storage) throw new TicketNoEncontradoError();
    let data: Buffer;
    try {
      data = await storage.get(tenantId, row.capturaKey);
    } catch (e) {
      this.ctx?.logger?.warn('mod.soporte: no se pudo leer la captura', {
        tenantId,
        ticketId,
        error: mensaje(e),
      });
      throw new TicketNoEncontradoError();
    }
    return {
      data,
      contentType: row.capturaContentType ?? 'application/octet-stream',
      nombre: row.capturaNombre ?? `captura.${extensionDe(row.capturaContentType ?? '')}`,
    };
  }

  // ── Equipo del aula ────────────────────────────────────────────────────────

  /** Tickets del aula (filtrados, los 200 más nuevos) y cuántos hay en cada estado. */
  async listarAdmin(
    tenantId: string,
    caller: Caller,
    filtros: AdminFiltros,
  ): Promise<AdminListado> {
    soloAdmin(caller);
    const estado = (ESTADOS_TICKET as readonly unknown[]).includes(filtros.estado)
      ? filtros.estado
      : undefined;
    const tipo = (TIPOS_TICKET as readonly unknown[]).includes(filtros.tipo)
      ? filtros.tipo
      : undefined;
    const [rows, ...porEstado] = await Promise.all([
      this.tickets.findMany({
        where: { tenantId, estado, tipo },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIMITES.listaAdmin,
      }) as Promise<TicketRow[]>,
      ...ESTADOS_TICKET.map((e) => this.tickets.count({ where: { tenantId, estado: e } })),
    ]);
    const counts = Object.fromEntries(
      ESTADOS_TICKET.map((e, i) => [e, porEstado[i] ?? 0]),
    ) as Record<EstadoTicket, number>;
    return { items: rows.map(vistaAdmin), counts };
  }

  /**
   * Lo que pide el menú para la entrada «Tickets de soporte»: si se enseña y
   * cuántos tickets nuevos hay (los que nadie ha cogido). A quien no
   * administra no se le enseña la entrada ni se le cuenta nada.
   */
  async menuAdmin(
    tenantId: string,
    caller: Caller,
  ): Promise<{ allowed: false } | { allowed: true; badge: number }> {
    if (!caller.esAdmin) return { allowed: false };
    const badge = await this.tickets.count({ where: { tenantId, estado: 'NUEVO' } });
    return { allowed: true, badge };
  }

  async obtenerAdmin(tenantId: string, caller: Caller, ticketId: string): Promise<AdminTicketView> {
    soloAdmin(caller);
    return vistaAdmin(await this.cargar(tenantId, ticketId));
  }

  /**
   * Cambia el estado o la nota interna. Cerrar (resuelto o descartado) pone
   * `closedAt`; volver a nuevo o en curso lo limpia. Solo si el estado cambia
   * de verdad se avisa al autor (en segundo plano) y se publica el evento.
   */
  async actualizarAdmin(
    tenantId: string,
    caller: Caller,
    ticketId: string,
    cambios: CambiosAdmin,
    now: Date = new Date(),
  ): Promise<AdminTicketView> {
    soloAdmin(caller);
    const tocaEstado = cambios.estado !== undefined;
    const tocaNota = cambios.notaInterna !== undefined;
    if (!tocaEstado && !tocaNota) throw new TextoInvalidoError('SIN_CAMBIOS');
    if (tocaEstado && !(ESTADOS_TICKET as readonly unknown[]).includes(cambios.estado)) {
      throw new TextoInvalidoError('ESTADO_INVALIDO');
    }
    const nota = tocaNota ? validarNota(cambios.notaInterna) : undefined;
    const antes = await this.cargar(tenantId, ticketId);

    const data: Record<string, unknown> = {};
    if (tocaNota) data['notaInterna'] = nota;
    const cambiaEstado = tocaEstado && cambios.estado !== antes.estado;
    if (cambiaEstado) {
      data['estado'] = cambios.estado;
      data['closedAt'] = ESTADOS_CERRADOS.includes(cambios.estado!) ? now : null;
    }
    if (Object.keys(data).length > 0) {
      await this.tickets.updateMany({ where: { id: ticketId, tenantId }, data });
    }
    const despues = await this.cargar(tenantId, ticketId);

    if (cambiaEstado) {
      await this.publish(tenantId, caller.id, 'soporte.ticket.status_changed', {
        ticketId,
        autorId: despues.autorId,
        estadoAnterior: antes.estado,
        estado: despues.estado,
      });
      if (despues.autorId !== caller.id) {
        this.lanzar(tenantId, 'cambio de estado', () => this.avisarAutor(despues));
      }
    }
    return vistaAdmin(despues);
  }

  /**
   * Espera a que terminen los avisos de fondo en curso (como mucho
   * `timeoutMs`). Para los tests y para que un apagado ordenado no corte un
   * correo a medias.
   */
  async esperarAvisos(timeoutMs = 10_000): Promise<void> {
    if (this.pendientes.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limite = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    // Un aviso puede lanzar otro: se espera hasta que no quede ninguno.
    const todos = (async () => {
      while (this.pendientes.size > 0) await Promise.allSettled([...this.pendientes]);
    })();
    await Promise.race([todos, limite]);
    if (timer) clearTimeout(timer);
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  private async cargar(tenantId: string, ticketId: string): Promise<TicketRow> {
    const row = (await this.tickets.findFirst({
      where: { id: ticketId, tenantId },
    })) as TicketRow | null;
    if (!row) throw new TicketNoEncontradoError();
    return row;
  }

  /**
   * Lanza una tarea de aviso SIN esperarla: la petición responde ya. La tarea
   * corre con el contexto del aula (puerto `enSegundoPlano`) y cualquier fallo
   * se queda en el log; nunca llega a quien llamó.
   */
  private lanzar(tenantId: string, que: string, tarea: () => Promise<void>): void {
    const correr = this.ports.enSegundoPlano
      ? () => this.ports.enSegundoPlano!(tenantId, tarea)
      : tarea;
    const p: Promise<void> = Promise.resolve()
      .then(correr)
      .catch((e) => {
        this.ctx?.logger?.error(`mod.soporte: falló el aviso de fondo (${que})`, {
          tenantId,
          error: mensaje(e),
        });
      })
      .finally(() => {
        this.pendientes.delete(p);
      });
    this.pendientes.add(p);
  }

  /** Guarda la captura bajo una clave aleatoria del ticket; `null` si no se pudo. */
  private async guardarCaptura(
    tenantId: string,
    ticketId: string,
    captura: ReturnType<typeof validarCaptura>,
  ): Promise<{ key: string; contentType: string; nombre: string; size: number } | null> {
    const storage = this.ports.storage;
    if (!storage) {
      this.ctx?.logger?.warn('mod.soporte: sin almacén de capturas; el ticket va sin ella', {
        tenantId,
        ticketId,
      });
      return null;
    }
    const key = `tenants/${tenantId}/soporte/${ticketId}/${randomUUID()}.${extensionDe(captura.contentType)}`;
    try {
      const stored = await storage.putImage(tenantId, key, captura.data, captura.contentType);
      const base = captura.nombre.slice(0, captura.nombre.lastIndexOf('.'));
      return {
        key: stored.key,
        contentType: stored.contentType,
        // El storage puede recomprimir a WebP: el nombre lleva la extensión real.
        nombre: `${base}.${extensionDe(stored.contentType)}`,
        size: stored.size,
      };
    } catch (e) {
      this.ctx?.logger?.warn('mod.soporte: no se pudo guardar la captura; el ticket va sin ella', {
        tenantId,
        ticketId,
        error: mensaje(e),
      });
      return null;
    }
  }

  /** Sube la captura de un ticket ya guardado y la apunta en él; si algo falla, lo deja sin ella. */
  private async adjuntarCaptura(
    row: TicketRow,
    captura: ReturnType<typeof validarCaptura>,
  ): Promise<TicketRow> {
    const guardada = await this.guardarCaptura(row.tenantId, row.id, captura);
    if (!guardada) return row;
    try {
      await this.tickets.updateMany({
        where: { id: row.id, tenantId: row.tenantId },
        data: {
          capturaKey: guardada.key,
          capturaContentType: guardada.contentType,
          capturaNombre: guardada.nombre,
          capturaSize: guardada.size,
        },
      });
    } catch (e) {
      this.ctx?.logger?.warn('mod.soporte: no se pudo apuntar la captura; el ticket va sin ella', {
        tenantId: row.tenantId,
        ticketId: row.id,
        key: guardada.key,
        error: mensaje(e),
      });
      return row;
    }
    return (
      ((await this.tickets.findFirst({
        where: { id: row.id, tenantId: row.tenantId },
      })) as TicketRow | null) ?? row
    );
  }

  /** Ticket nuevo: al operador de la plataforma y al equipo del aula, a la vez. */
  private async avisarTicketNuevo(row: TicketRow): Promise<void> {
    await Promise.all([this.avisarOperador(row), this.avisarAdmins(row)]);
  }

  /** Al operador de la plataforma (Cloud). Un fallo queda en el log con nivel de error. */
  private async avisarOperador(row: TicketRow): Promise<void> {
    const avisar = this.ports.avisarOperador;
    if (!avisar) return;
    try {
      await avisar({
        tenantId: row.tenantId,
        ticketId: row.id,
        tipo: row.tipo,
        texto: row.texto,
        autorId: row.autorId,
        autorNombre: row.autorNombre,
        tieneCaptura: row.capturaKey !== null,
        createdAt: row.createdAt,
      });
    } catch (e) {
      this.ctx?.logger?.error('mod.soporte: no se pudo avisar al operador del ticket nuevo', {
        tenantId: row.tenantId,
        ticketId: row.id,
        error: mensaje(e),
      });
    }
  }

  /** A cada administrador del aula (menos al autor), en la campana y por correo. */
  private async avisarAdmins(row: TicketRow): Promise<void> {
    let admins: string[];
    try {
      admins = await this.ports.adminIds(row.tenantId);
    } catch (e) {
      this.ctx?.logger?.warn('mod.soporte: no se pudo saber a qué administradores avisar', {
        tenantId: row.tenantId,
        ticketId: row.id,
        error: mensaje(e),
      });
      return;
    }
    const destinos = [...new Set(admins)].filter((id) => id !== row.autorId);
    if (destinos.length === 0) return;
    await this.enviar(row, PLANTILLA_TICKET_NUEVO, destinos, {
      ticketId: row.id,
      autorNombre: row.autorNombre,
      extracto: extracto(row.texto),
      ...marcasTipo(row.tipo),
      ticketUrl: await this.enlace(row.tenantId, `${RUTA_BANDEJA}?ticket=${row.id}`),
    });
  }

  /** Cambio de estado: al autor, en la campana y por correo. Nunca lleva la nota interna. */
  private async avisarAutor(row: TicketRow): Promise<void> {
    await this.enviar(row, PLANTILLA_TICKET_ESTADO, [row.autorId], {
      ticketId: row.id,
      extracto: extracto(row.texto),
      ...marcasTipo(row.tipo),
      ...marcasEstado(row.estado),
      ticketUrl: await this.enlace(row.tenantId, `${RUTA_MIS_TICKETS}?ticket=${row.id}`),
    });
  }

  /** Enlace absoluto para el correo; `''` si no se sabe la dirección del aula. */
  private async enlace(tenantId: string, ruta: string): Promise<string> {
    if (!this.ports.webBaseUrl) return '';
    try {
      const base = sinBarraFinal(await this.ports.webBaseUrl(tenantId));
      return base ? `${base}${ruta}` : '';
    } catch (e) {
      this.ctx?.logger?.warn('mod.soporte: no se pudo saber la dirección del aula', {
        tenantId,
        error: mensaje(e),
      });
      return '';
    }
  }

  private async enviar(
    row: TicketRow,
    templateKey: string,
    destinos: string[],
    variables: Record<string, unknown>,
  ): Promise<void> {
    const hub = this.ctx?.notificationHub;
    if (!hub || destinos.length === 0) return;
    const envios = destinos.flatMap((to) =>
      (['in-app', 'email'] as const).map((channel) => ({ to, channel })),
    );
    // Sin `locale`: el hub escribe a cada persona en su idioma (el del aula si
    // no tiene uno propio).
    const resultados = await Promise.allSettled(
      envios.map(({ to, channel }) =>
        hub.send({
          tenantId: row.tenantId,
          channel,
          templateKey,
          to,
          category: 'SYSTEM',
          variables,
        }),
      ),
    );
    resultados.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.ctx?.logger?.warn('mod.soporte: falló un aviso', {
          tenantId: row.tenantId,
          ticketId: row.id,
          templateKey,
          to: envios[i]!.to,
          channel: envios[i]!.channel,
          error: mensaje(r.reason),
        });
      }
    });
  }

  private async publish(
    tenantId: string,
    actorId: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const bus = this.ctx?.eventBus;
    if (!bus) return;
    try {
      await bus.publish({
        name,
        version: 1,
        data,
        metadata: {
          tenantId,
          userId: actorId,
          timestamp: new Date().toISOString(),
          traceId: randomUUID(),
          idempotencyKey: eventIdempotencyKey(name, data),
        },
      });
    } catch (e) {
      this.ctx?.logger?.warn('mod.soporte: no se pudo publicar el evento', {
        tenantId,
        name,
        error: mensaje(e),
      });
    }
  }
}

function soloAdmin(caller: Caller): void {
  if (!caller.esAdmin) throw new SinPermisoError();
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function vista(row: TicketRow): TicketView {
  return {
    id: row.id,
    tipo: row.tipo,
    texto: row.texto,
    estado: row.estado,
    tieneCaptura: row.capturaKey !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: iso(row.closedAt),
  };
}

function vistaAdmin(row: TicketRow): AdminTicketView {
  return {
    ...vista(row),
    autorId: row.autorId,
    autorNombre: row.autorNombre,
    contexto: {
      url: row.contextoUrl,
      userAgent: row.contextoUserAgent,
      viewport: row.contextoViewport,
      at: iso(row.contextoAt),
    },
    notaInterna: row.notaInterna,
  };
}
