'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { authStorage } from '@/lib/auth-storage';
import { formatDateTime } from '@/lib/i18n/format';
import { CapturaImagen } from './captura-imagen';
import {
  esProhibido,
  mensajeDeError,
  soporteApi,
  type AdminTicketView,
  type ConteoPorEstado,
} from './client';
import {
  ESTADOS,
  NOTA_MAX,
  TIPOS,
  estadoBadge,
  puedeVerBandeja,
  ticketPedido,
  urlEnlazable,
  type EstadoTicket,
  type TipoTicket,
} from './logic';

const labelClass = 'mb-1 block text-sm font-medium text-text';
const FECHA: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

type Acceso = 'comprobando' | 'si' | 'no';

/**
 * Bandeja del equipo de mod.soporte (/admin/support): los tickets del aula,
 * filtrables por estado y tipo, con su contexto, la captura, el cambio de
 * estado (que avisa a quien lo abrió) y una nota interna que el miembro no ve.
 * Solo super_admin y tenant_admin; la API lo exige igualmente (403).
 */
export function AdminSoporte() {
  const t = useTranslations('modSoporte');
  const tErrors = useTranslations('errors');
  const params = useSearchParams();
  const pedido = ticketPedido(params.get('ticket'));
  const [acceso, setAcceso] = useState<Acceso>('comprobando');
  const [apagado, setApagado] = useState(false);
  const [estado, setEstado] = useState<EstadoTicket | ''>('');
  const [tipo, setTipo] = useState<TipoTicket | ''>('');
  const [items, setItems] = useState<AdminTicketView[] | null>(null);
  const [counts, setCounts] = useState<ConteoPorEstado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<string | null>(pedido);
  const detalleRef = useRef<HTMLDivElement | null>(null);

  // El rol se lee tras montar: la sesión vive en el navegador.
  useEffect(() => {
    const roles = authStorage.getSession()?.user.roles ?? [];
    setAcceso(puedeVerBandeja(roles) ? 'si' : 'no');
  }, []);

  useEffect(() => {
    if (pedido) setSeleccion(pedido);
  }, [pedido]);

  const recargar = useCallback(async () => {
    setError(null);
    try {
      const r = await soporteApi.adminListar({ estado, tipo });
      setItems(r.items);
      setCounts(r.counts);
    } catch (e) {
      if (esProhibido(e)) setApagado(true);
      else setError(mensajeDeError(e, tErrors, t));
    }
  }, [estado, tipo, t, tErrors]);

  useEffect(() => {
    if (acceso === 'si') void recargar();
  }, [acceso, recargar]);

  function elegir(id: string) {
    setSeleccion(id);
    // En el móvil la ficha va debajo de la lista: se baja hasta ella.
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      requestAnimationFrame(() =>
        detalleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    }
  }

  if (acceso === 'comprobando') return <div className="skeleton h-10 w-72 max-w-full" />;

  if (acceso === 'no') {
    return (
      <Card>
        <CardContent
          className="p-8 text-center text-sm text-text-muted"
          data-testid="soporte-sin-acceso"
        >
          {t('bandeja.sinAcceso')}
        </CardContent>
      </Card>
    );
  }

  if (apagado) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-text-muted">
          {t('bandeja.apagado')}
        </CardContent>
      </Card>
    );
  }

  const total = counts ? ESTADOS.reduce((n, e) => n + (counts[e] ?? 0), 0) : null;

  return (
    <div className="space-y-6" data-testid="soporte-bandeja">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">{t('bandeja.titulo')}</h1>
        <p className="mt-1 text-sm text-text-muted">{t('bandeja.subtitulo')}</p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('bandeja.filtroEstado')}>
          <FiltroEstado activo={estado === ''} onClick={() => setEstado('')}>
            {total !== null
              ? t('bandeja.conteo', { label: t('bandeja.todos'), n: total })
              : t('bandeja.todos')}
          </FiltroEstado>
          {ESTADOS.map((e) => (
            <FiltroEstado
              key={e}
              activo={estado === e}
              onClick={() => setEstado(e)}
              testId={`soporte-filtro-${e}`}
            >
              {counts
                ? t('bandeja.conteo', { label: t(`estados.${e}`), n: counts[e] ?? 0 })
                : t(`estados.${e}`)}
            </FiltroEstado>
          ))}
        </div>
        <div className="w-full sm:ml-auto sm:w-56">
          <NativeSelect
            aria-label={t('bandeja.filtroTipo')}
            value={tipo}
            onChange={(ev) => setTipo(ev.target.value as TipoTicket | '')}
          >
            <option value="">{t('bandeja.todosLosTipos')}</option>
            {TIPOS.map((valor) => (
              <option key={valor} value={valor}>
                {t(`tipos.${valor}.label`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          {items === null && !error ? (
            <div className="space-y-2">
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-16 w-full" />
            </div>
          ) : null}
          {items && items.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-sm text-text-muted">
                {t('bandeja.sinTickets')}
              </CardContent>
            </Card>
          ) : null}
          {items && items.length > 0 ? (
            <ul className="space-y-2" data-testid="soporte-admin-lista">
              {items.map((ticket) => (
                <li key={ticket.id}>
                  <button
                    type="button"
                    onClick={() => elegir(ticket.id)}
                    data-testid="soporte-admin-ticket"
                    data-ticket-id={ticket.id}
                    aria-current={seleccion === ticket.id ? 'true' : undefined}
                    className={
                      'w-full rounded-card border bg-surface p-3 text-left transition-colors hover:bg-surface-2 ' +
                      (seleccion === ticket.id
                        ? 'border-brand-500 ring-2 ring-brand-200'
                        : 'border-border')
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold text-text">
                        {t(`tipos.${ticket.tipo}.label`)}
                      </span>
                      <Badge variant={estadoBadge(ticket.estado)}>
                        {t(`estados.${ticket.estado}`)}
                      </Badge>
                      <span className="ml-auto text-xs text-text-muted">
                        {formatDateTime(ticket.createdAt, FECHA)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text-muted">
                      {ticket.autorNombre || t('bandeja.miembro')}
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-text">{ticket.texto}</p>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div ref={detalleRef} className="scroll-mt-28">
          {seleccion ? (
            <DetalleTicket key={seleccion} id={seleccion} onGuardado={() => void recargar()} />
          ) : (
            <Card>
              <CardContent className="p-6 text-center text-sm text-text-muted">
                {t('bandeja.elige')}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function FiltroEstado({
  activo,
  onClick,
  children,
  testId,
}: {
  activo: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={activo}
      data-testid={testId}
      className={
        'rounded-full border px-3 py-1 text-sm tabular-nums transition-colors ' +
        (activo
          ? 'border-brand-500 bg-brand-50 font-semibold text-text'
          : 'border-border text-text-muted hover:bg-surface-2')
      }
    >
      {children}
    </button>
  );
}

function DetalleTicket({ id, onGuardado }: { id: string; onGuardado: () => void }) {
  const t = useTranslations('modSoporte');
  const tErrors = useTranslations('errors');
  const [ticket, setTicket] = useState<AdminTicketView | null>(null);
  const [estado, setEstado] = useState<EstadoTicket>('NUEVO');
  const [nota, setNota] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState(false);

  useEffect(() => {
    let alive = true;
    soporteApi
      .adminObtener(id)
      .then((r) => {
        if (!alive) return;
        setTicket(r);
        setEstado(r.estado);
        setNota(r.notaInterna ?? '');
      })
      .catch((e) => {
        if (alive) setError(mensajeDeError(e, tErrors, t));
      });
    return () => {
      alive = false;
    };
  }, [id, t, tErrors]);

  async function guardar() {
    setGuardando(true);
    setGuardado(false);
    setError(null);
    try {
      const r = await soporteApi.adminActualizar(id, {
        estado,
        notaInterna: nota.trim() ? nota.trim() : null,
      });
      setTicket(r);
      setEstado(r.estado);
      setNota(r.notaInterna ?? '');
      setGuardado(true);
      onGuardado();
    } catch (e) {
      setError(mensajeDeError(e, tErrors, t));
    } finally {
      setGuardando(false);
    }
  }

  if (!ticket) {
    return error ? (
      <div
        role="alert"
        className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
      >
        {error}
      </div>
    ) : (
      <div className="skeleton h-64 w-full" />
    );
  }

  const url = urlEnlazable(ticket.contexto.url);

  return (
    <Card data-testid="soporte-admin-detalle" data-ticket-id={ticket.id}>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-text">{t(`tipos.${ticket.tipo}.label`)}</span>
          <Badge variant={estadoBadge(ticket.estado)}>{t(`estados.${ticket.estado}`)}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-text-muted">{t('bandeja.autor')}</dt>
          <dd className="text-text" data-testid="soporte-autor">
            {ticket.autorNombre || t('bandeja.miembro')}
          </dd>
          <dt className="text-text-muted">{t('bandeja.abierto')}</dt>
          <dd className="text-text">{formatDateTime(ticket.createdAt, FECHA)}</dd>
          <dt className="text-text-muted">{t('bandeja.actualizado')}</dt>
          <dd className="text-text">{formatDateTime(ticket.updatedAt, FECHA)}</dd>
          {ticket.closedAt ? (
            <>
              <dt className="text-text-muted">{t('bandeja.cerrado')}</dt>
              <dd className="text-text">{formatDateTime(ticket.closedAt, FECHA)}</dd>
            </>
          ) : null}
        </dl>

        <p
          className="whitespace-pre-wrap break-words text-sm text-text"
          data-testid="soporte-texto"
        >
          {ticket.texto}
        </p>

        {ticket.tieneCaptura ? <CapturaImagen ticketId={ticket.id} /> : null}

        <div className="rounded-md bg-surface-2 p-3 text-xs" data-testid="soporte-contexto">
          <p className="mb-1 font-semibold text-text">{t('bandeja.contexto')}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-text-muted">{t('bandeja.pagina')}</dt>
            <dd className="break-all">
              {url ? (
                <a href={url} target="_blank" rel="noreferrer" className="text-brand-600 underline">
                  {ticket.contexto.url}
                </a>
              ) : (
                <span className="text-text">{ticket.contexto.url ?? '—'}</span>
              )}
            </dd>
            <dt className="text-text-muted">{t('bandeja.navegador')}</dt>
            <dd className="break-words text-text">{ticket.contexto.userAgent ?? '—'}</dd>
            <dt className="text-text-muted">{t('bandeja.ventana')}</dt>
            <dd className="text-text">{ticket.contexto.viewport ?? '—'}</dd>
            <dt className="text-text-muted">{t('bandeja.hora')}</dt>
            <dd className="text-text">
              {ticket.contexto.at ? formatDateTime(ticket.contexto.at, FECHA) : '—'}
            </dd>
          </dl>
        </div>

        <div>
          <label htmlFor={`estado-${ticket.id}`} className={labelClass}>
            {t('bandeja.estado')}
          </label>
          <NativeSelect
            id={`estado-${ticket.id}`}
            value={estado}
            onChange={(e) => setEstado(e.target.value as EstadoTicket)}
            data-testid="soporte-admin-estado"
          >
            {ESTADOS.map((e) => (
              <option key={e} value={e}>
                {t(`estados.${e}`)}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div>
          <label htmlFor={`nota-${ticket.id}`} className={labelClass}>
            {t('bandeja.nota')}{' '}
            <span className="font-normal text-text-muted">· {t('bandeja.notaAyuda')}</span>
          </label>
          <Textarea
            id={`nota-${ticket.id}`}
            value={nota}
            rows={3}
            maxLength={NOTA_MAX}
            onChange={(e) => setNota(e.target.value)}
            data-testid="soporte-admin-nota"
          />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-danger-700">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-3">
          {guardado ? (
            <span className="text-sm text-text-muted" data-testid="soporte-admin-guardado">
              {t('bandeja.guardado')}
            </span>
          ) : null}
          <Button
            type="button"
            onClick={() => void guardar()}
            disabled={guardando}
            data-testid="soporte-admin-guardar"
          >
            {guardando ? t('bandeja.guardando') : t('bandeja.guardar')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
