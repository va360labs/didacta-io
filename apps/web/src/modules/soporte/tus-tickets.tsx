'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatDateTime } from '@/lib/i18n/format';
import { CapturaImagen } from './captura-imagen';
import { esProhibido, mensajeDeError, soporteApi, type TicketView } from './client';
import { estadoBadge, ticketPedido } from './logic';
import { SoporteDialog } from './soporte-dialog';
import { useSoporteCanal } from './use-soporte';

const FECHA: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

/**
 * «Tus tickets» (/support): los tickets de quien mira, del más nuevo al más
 * viejo, con su estado. Nunca la nota interna (la API no la manda). Los que
 * escribió a Didacta (quien administra el aula) no tienen un estado que cambie
 * aquí: dicen «Enviado a Didacta» y que la respuesta llega por correo.
 * `?ticket=<id>` marca ese y lleva hasta él: lo usa el aviso de la campana y
 * el correo cuando cambia de estado.
 */
export function TusTickets() {
  const t = useTranslations('modSoporte');
  const tErrors = useTranslations('errors');
  const params = useSearchParams();
  const pedido = ticketPedido(params.get('ticket'));
  const [tickets, setTickets] = useState<TicketView[] | null>(null);
  const [apagado, setApagado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nuevo, setNuevo] = useState(false);
  const canal = useSoporteCanal();
  const aDidacta = canal?.destino === 'PLATAFORMA';

  const recargar = useCallback(async () => {
    setError(null);
    try {
      const lista = await soporteApi.mios();
      // La API ya los da del más nuevo al más viejo; se asegura aquí.
      setTickets([...lista].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (e) {
      if (esProhibido(e)) setApagado(true);
      else setError(mensajeDeError(e, tErrors, t));
    }
  }, [t, tErrors]);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  useEffect(() => {
    if (!pedido || !tickets) return;
    document.getElementById(`ticket-${pedido}`)?.scrollIntoView({ block: 'center' });
  }, [pedido, tickets]);

  if (apagado) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-text-muted">
          {t('mios.apagado')}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="soporte-mios">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">{t('mios.titulo')}</h1>
          <p className="mt-1 text-sm text-text-muted">
            {aDidacta ? t('mios.subtituloPlataforma') : t('mios.subtitulo')}
          </p>
        </div>
        {canal?.disponible ? (
          <Button type="button" onClick={() => setNuevo(true)} data-testid="soporte-nuevo">
            {t('mios.nuevo')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {tickets === null && !error ? (
        <div className="space-y-3">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : null}

      {tickets && tickets.length === 0 ? (
        <Card>
          <CardContent
            className="p-8 text-center text-sm text-text-muted"
            data-testid="soporte-vacio"
          >
            {t('mios.vacio')}
          </CardContent>
        </Card>
      ) : null}

      {tickets && tickets.length > 0 ? (
        <ul className="space-y-3" data-testid="soporte-lista">
          {tickets.map((ticket) => (
            <li
              key={ticket.id}
              id={`ticket-${ticket.id}`}
              data-testid="soporte-ticket"
              data-ticket-id={ticket.id}
              aria-current={ticket.id === pedido ? 'true' : undefined}
              className={
                'rounded-card border bg-surface p-4 ' +
                (ticket.id === pedido ? 'border-brand-500 ring-2 ring-brand-200' : 'border-border')
              }
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-text">
                  {ticket.destino === 'PLATAFORMA'
                    ? t(`tiposPlataforma.${ticket.tipo}.label`)
                    : t(`tipos.${ticket.tipo}.label`)}
                </span>
                {ticket.destino === 'PLATAFORMA' ? (
                  <Badge variant="info" data-testid="soporte-estado">
                    {t('mios.enviadoADidacta')}
                  </Badge>
                ) : (
                  <Badge variant={estadoBadge(ticket.estado)} data-testid="soporte-estado">
                    {t(`estados.${ticket.estado}`)}
                  </Badge>
                )}
                <span className="ml-auto text-xs text-text-muted">
                  {formatDateTime(ticket.createdAt, FECHA)}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text">
                {ticket.texto}
              </p>
              {ticket.destino === 'PLATAFORMA' ? (
                <p className="mt-2 text-xs text-text-muted" data-testid="soporte-respuesta-correo">
                  {t('mios.respuestaPorCorreo')}
                </p>
              ) : null}
              {ticket.tieneCaptura ? (
                <div className="mt-3">
                  <CapturaImagen ticketId={ticket.id} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <SoporteDialog
        open={nuevo}
        onClose={() => setNuevo(false)}
        onEnviado={() => void recargar()}
        destino={canal?.destino ?? 'AULA'}
      />
    </div>
  );
}
