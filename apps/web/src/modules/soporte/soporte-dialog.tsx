'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { archivoABase64, mensajeDeError, soporteApi, type TicketView } from './client';
import {
  TEXTO_MAX,
  TEXTO_MIN,
  TIPOS,
  TIPOS_CAPTURA,
  construirContexto,
  construirPayload,
  validarCaptura,
  validarTexto,
  type TipoCaptura,
  type TipoTicket,
} from './logic';

const labelClass = 'mb-1 block text-sm font-medium text-text';

/** Ruta de «Tus tickets» (ADR-060: URL en inglés). */
export const RUTA_MIS_TICKETS = '/support';

/**
 * «Ayuda y sugerencias»: abre un ticket (sugerencia, fallo o problema) con
 * captura opcional. La página, el navegador, la ventana y la hora se mandan
 * solos. La API responde en cuanto guarda el ticket (los avisos al equipo
 * salen después), así que «Enviando…» dura lo que tarda en guardarse.
 */
export function SoporteDialog({
  open,
  onClose,
  onEnviado,
}: {
  open: boolean;
  onClose: () => void;
  onEnviado?: (t: TicketView) => void;
}) {
  const t = useTranslations('modSoporte');
  const tErrors = useTranslations('errors');
  const formId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tipo, setTipo] = useState<TipoTicket>(TIPOS[0]!);
  const [texto, setTexto] = useState('');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviado, setEnviado] = useState<TicketView | null>(null);

  // Cada vez que se abre, empieza en blanco.
  useEffect(() => {
    if (!open) return;
    setTipo(TIPOS[0]!);
    setTexto('');
    setArchivo(null);
    setError(null);
    setEnviado(null);
    setEnviando(false);
  }, [open]);

  useEffect(() => {
    if (!archivo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(archivo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [archivo]);

  function elegirArchivo(file: File | undefined) {
    if (!file) return;
    const err = validarCaptura(file);
    if (err) {
      setError(t(`validacion.${err}`));
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setError(null);
    setArchivo(file);
  }

  function quitarArchivo() {
    setArchivo(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function enviar(ev: React.FormEvent) {
    ev.preventDefault();
    if (enviando) return;
    const err = validarTexto(texto);
    if (err) {
      setError(t(`validacion.${err}`, { min: TEXTO_MIN, max: TEXTO_MAX }));
      return;
    }
    setEnviando(true);
    setError(null);
    try {
      const contexto = construirContexto({
        href: window.location.href,
        userAgent: navigator.userAgent,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        now: new Date(),
      });
      const captura = archivo
        ? {
            data: await archivoABase64(archivo),
            filename: archivo.name || 'captura',
            contentType: archivo.type as TipoCaptura,
          }
        : undefined;
      const ticket = await soporteApi.crear(construirPayload({ tipo, texto, contexto, captura }));
      setEnviado(ticket);
      onEnviado?.(ticket);
    } catch (e) {
      setError(mensajeDeError(e, tErrors, t));
    } finally {
      setEnviando(false);
    }
  }

  if (enviado) {
    return (
      <Dialog
        open={open}
        onOpenChange={(v) => (v ? undefined : onClose())}
        title={t('dialogo.enviadoTitulo')}
        description={t('dialogo.enviadoDescripcion')}
      >
        <p className="text-sm text-text" data-testid="soporte-enviado">
          {t('dialogo.enviadoTexto')}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('dialogo.cerrar')}
          </Button>
          <Button asChild>
            <Link href={RUTA_MIS_TICKETS} onClick={onClose} data-testid="soporte-ver-tickets">
              {t('dialogo.verMisTickets')}
            </Link>
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => (v ? undefined : onClose())}
      title={t('dialogo.titulo')}
      description={t('dialogo.descripcion')}
      maxWidthClass="max-w-xl"
    >
      <form id={formId} onSubmit={(e) => void enviar(e)} data-testid="soporte-form">
        <div className="space-y-4">
          <fieldset>
            <legend className={labelClass}>{t('dialogo.tipo')}</legend>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
              {TIPOS.map((valor) => (
                <label
                  key={valor}
                  data-testid={`soporte-tipo-${valor}`}
                  className={
                    'flex cursor-pointer flex-col rounded-lg border px-3 py-2 text-sm transition-colors ' +
                    (tipo === valor
                      ? 'border-brand-500 bg-brand-50 text-text'
                      : 'border-border hover:bg-surface-2')
                  }
                >
                  <span className="flex items-center gap-2 font-medium">
                    <input
                      type="radio"
                      name="soporte-tipo"
                      value={valor}
                      checked={tipo === valor}
                      onChange={() => setTipo(valor)}
                    />
                    {t(`tipos.${valor}.label`)}
                  </span>
                  <span className="mt-0.5 text-xs text-text-muted">
                    {t(`tipos.${valor}.ayuda`)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor={`${formId}-texto`} className={labelClass}>
              {t(`tipos.${tipo}.pregunta`)}
            </label>
            <Textarea
              id={`${formId}-texto`}
              value={texto}
              rows={5}
              maxLength={TEXTO_MAX}
              required
              onChange={(e) => setTexto(e.target.value)}
              placeholder={t(`tipos.${tipo}.pista`)}
              data-testid="soporte-texto-input"
            />
            <p className="mt-1 text-right text-xs text-text-muted tabular-nums">
              {t('dialogo.contador', { n: texto.trim().length, max: TEXTO_MAX })}
            </p>
          </div>

          <div>
            <label htmlFor={`${formId}-captura`} className={labelClass}>
              {t('dialogo.captura')}
            </label>
            {preview ? (
              <div className="flex items-start gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview}
                  alt={t('dialogo.vistaPrevia')}
                  className="h-24 w-auto max-w-[14rem] rounded-md border border-border object-cover"
                  data-testid="soporte-preview"
                />
                <Button type="button" variant="ghost" size="sm" onClick={quitarArchivo}>
                  {t('dialogo.quitar')}
                </Button>
              </div>
            ) : null}
            <input
              ref={fileRef}
              id={`${formId}-captura`}
              type="file"
              accept={TIPOS_CAPTURA.join(',')}
              className={preview ? 'sr-only' : 'block w-full text-sm text-text-muted'}
              onChange={(e) => elegirArchivo(e.target.files?.[0])}
              data-testid="soporte-captura-input"
            />
            <p className="mt-1 text-xs text-text-muted">{t('dialogo.capturaAyuda')}</p>
          </div>

          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-text-muted">
            {t('dialogo.contexto')}
          </p>

          {error ? (
            <p role="alert" className="text-sm text-danger-700" data-testid="soporte-error">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              href={RUTA_MIS_TICKETS}
              onClick={onClose}
              className="text-sm font-medium text-brand-600 hover:underline"
              data-testid="soporte-mis-tickets"
            >
              {t('dialogo.verMisTickets')}
            </Link>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('dialogo.cancelar')}
              </Button>
              <Button type="submit" disabled={enviando} data-testid="soporte-enviar">
                {enviando ? t('dialogo.enviando') : t('dialogo.enviar')}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
