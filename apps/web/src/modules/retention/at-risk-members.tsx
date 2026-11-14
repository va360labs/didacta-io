'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Dialog } from '@/components/ui/dialog';
import { UserAvatar } from '@/components/user-chip';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { cn } from '@/lib/utils';
import { messagingApi } from '@/modules/messaging';
import {
  isModuleOff,
  retentionApi,
  type AtRiskReason,
  type AtRiskReasonKind,
  type AtRiskResult,
  type AtRiskRow,
  type RetentionTemplate,
} from './client';

const DAY_OPTIONS = [7, 14, 30, 60] as const;
const REASONS: ReadonlyArray<AtRiskReasonKind | null> = [
  null,
  'inactive',
  'paid_not_started',
  'stalled',
];

/**
 * «Miembros en riesgo»: quién lleva días sin entrar, quién pagó y no ha
 * empezado y quién se quedó a medias en un curso, con un botón para escribirle
 * (mensaje directo con plantilla) y otro para meterle en el mensaje de
 * recuperación. Todo sale de la actividad real del aula: nada inventado.
 */
export function AtRiskMembers() {
  const t = useTranslations('modRetention.riesgo');
  const tErrors = useTranslations('errors');
  const [days, setDays] = useState<number>(14);
  const [reason, setReason] = useState<AtRiskReasonKind | null>(null);
  const [search, setSearch] = useState('');
  const [data, setData] = useState<AtRiskResult | null>(null);
  const [moduleOff, setModuleOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [writing, setWriting] = useState<AtRiskRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await retentionApi.atRisk({ days, reason, search }));
      setError(null);
    } catch (err) {
      if (isModuleOff(err)) setModuleOff(true);
      else setError(apiErrorMessage(err, tErrors));
    }
  }, [days, reason, search, tErrors]);

  useEffect(() => {
    const id = setTimeout(() => void load(), search ? 300 : 0);
    return () => clearTimeout(id);
  }, [load, search]);

  async function activateRecovery() {
    setBusy('recovery');
    try {
      await retentionApi.activateTemplate('come_back');
      setNotice(t('recuperacionActivada'));
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setBusy(null);
    }
  }

  async function addToRecovery(row: AtRiskRow) {
    setBusy(row.id);
    try {
      const res = await retentionApi.addToRecovery(row.id);
      setNotice(
        res.queued ? t('anadido', { nombre: row.name }) : t('yaEstaba', { nombre: row.name }),
      );
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setBusy(null);
    }
  }

  if (moduleOff) {
    return (
      <div className="mx-auto max-w-[880px] rounded-2xl border border-border bg-surface p-6 text-text-muted">
        {t('moduloApagado')}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[960px]" data-testid="miembros-en-riesgo">
      <Link
        href="/admin/users"
        className="inline-flex items-center gap-1 text-sm font-semibold text-text-muted hover:text-text"
      >
        <Icon name="arrow-left" size={14} />
        {t('volver')}
      </Link>
      <h1 className="mt-2 text-[26px] leading-tight font-extrabold tracking-tight text-text">
        {t('titulo')}
      </h1>
      <p className="mt-1 max-w-[70ch] text-text-muted">{t('sub')}</p>

      {data && !data.recovery.automationId ? (
        <section
          className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl bg-brand-50 p-4"
          data-testid="sin-recuperacion"
        >
          <Icon name="clock" size={20} />
          <p className="min-w-0 flex-1 text-sm text-text">{t('sinRecuperacion')}</p>
          <button
            type="button"
            disabled={busy === 'recovery'}
            onClick={() => void activateRecovery()}
            className="h-10 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {t('activarRecuperacion')}
          </button>
        </section>
      ) : null}

      <section className="mt-5 rounded-2xl border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          {REASONS.map((r) => (
            <button
              key={r ?? 'all'}
              type="button"
              aria-pressed={reason === r}
              onClick={() => setReason(r)}
              data-testid={`filtro-${r ?? 'todos'}`}
              className={cn(
                'rounded-full px-3 py-1.5 text-sm font-semibold',
                reason === r
                  ? 'bg-brand-600 text-white'
                  : 'bg-bg-subtle text-text hover:bg-border-soft',
              )}
            >
              {t(`motivoFiltro.${r ?? 'all'}`)}
              {data ? <span className="ml-1.5 opacity-80">{data.counts[r ?? 'all']}</span> : null}
            </button>
          ))}
          <span className="flex-1" />
          <label className="flex items-center gap-2 text-sm text-text-muted">
            {t('diasSinEntrar')}
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-text"
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {t('dias', { n: d })}
                </option>
              ))}
            </select>
          </label>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('buscar')}
            aria-label={t('buscar')}
            className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm sm:w-56"
          />
        </div>

        {notice ? (
          <p
            role="status"
            className="mx-4 mt-3 rounded-xl bg-success-50 p-3 text-sm font-semibold text-success-700"
          >
            {notice}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="mx-4 mt-3 rounded-xl bg-danger-50 p-3 text-sm font-semibold text-danger-700"
          >
            {error}
          </p>
        ) : null}

        {data === null ? (
          <div className="skeleton m-4 h-24" />
        ) : data.rows.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-success-50 text-success-700">
              <Icon name="check" size={24} />
            </span>
            <p className="mt-3 font-semibold text-text">{t('vacioTitulo')}</p>
            <p className="mt-1 text-sm text-text-muted">{t('vacioTexto', { dias: data.days })}</p>
          </div>
        ) : (
          <ul data-testid="lista-riesgo">
            {data.rows.map((row) => (
              <li
                key={row.id}
                data-testid={`riesgo-${row.email}`}
                className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <UserAvatar name={row.name} email={row.email} avatarUrl={row.avatarUrl} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/users/${row.id}`}
                      className="font-semibold text-text hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.inRecovery ? (
                      <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-700">
                        {t('enRecuperacion')}
                      </span>
                    ) : null}
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {row.reasons.map((r, i) => (
                      <li key={i} className="flex items-center gap-1.5 text-sm text-text-muted">
                        <Icon name={reasonIcon(r)} size={13} />
                        <ReasonText reason={r} joinedAt={row.joinedAt} />
                      </li>
                    ))}
                  </ul>
                  {row.lastAutomatedAt ? (
                    <p className="mt-1 text-xs text-text-subtle">
                      {t('ultimoAutomatico', {
                        fecha: formatDate(row.lastAutomatedAt, { dateStyle: 'medium' }),
                      })}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setNotice(null);
                      setWriting(row);
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700"
                  >
                    <Icon name="message" size={15} />
                    {t('escribir')}
                  </button>
                  {data.recovery.automationId && !row.inRecovery ? (
                    <button
                      type="button"
                      disabled={busy === row.id}
                      onClick={() => void addToRecovery(row)}
                      className="h-9 rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-text hover:border-border-strong disabled:opacity-50"
                    >
                      {t('anadirRecuperacion')}
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {writing ? (
        <WriteDialog
          row={writing}
          onClose={() => setWriting(null)}
          onSent={(name) => {
            setWriting(null);
            setNotice(t('enviado', { nombre: name }));
          }}
        />
      ) : null}
    </div>
  );
}

function reasonIcon(r: AtRiskReason): 'clock' | 'lock' | 'book' {
  if (r.kind === 'inactive') return 'clock';
  if (r.kind === 'paid_not_started') return 'lock';
  return 'book';
}

function ReasonText({ reason, joinedAt }: { reason: AtRiskReason; joinedAt: string }) {
  const t = useTranslations('modRetention.riesgo');
  if (reason.kind === 'inactive') {
    return (
      <span>
        {reason.neverEntered
          ? t('motivo.nuncaEntro', { fecha: formatDate(joinedAt, { dateStyle: 'medium' }) })
          : t('motivo.sinEntrar', { dias: reason.days })}
      </span>
    );
  }
  if (reason.kind === 'paid_not_started') {
    return (
      <span>
        {t('motivo.pagoSinEmpezar', { fecha: formatDate(reason.paidAt, { dateStyle: 'medium' }) })}
      </span>
    );
  }
  return (
    <span>
      {t('motivo.aMedias', { curso: reason.courseTitle, progreso: reason.progressPercent })}
      {reason.lastActivityAt
        ? ` · ${t('motivo.sinAvanzar', { fecha: formatDate(reason.lastActivityAt, { dateStyle: 'medium' }) })}`
        : ''}
    </span>
  );
}

/**
 * «Escribir»: un mensaje directo de quien administra, a mano pero con
 * plantilla. El texto sale de la plantilla de recuperación (o la que se elija)
 * con los datos REALES de esa persona y se puede editar antes de enviar.
 */
function WriteDialog({
  row,
  onClose,
  onSent,
}: {
  row: AtRiskRow;
  onClose: () => void;
  onSent: (name: string) => void;
}) {
  const t = useTranslations('modRetention.riesgo');
  const tErrors = useTranslations('errors');
  const [templates, setTemplates] = useState<RetentionTemplate[]>([]);
  const [templateKey, setTemplateKey] = useState('come_back');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    retentionApi
      .templates()
      .then(setTemplates)
      .catch((err) => setError(apiErrorMessage(err, tErrors)));
  }, [tErrors]);

  useEffect(() => {
    const tpl = templates.find((x) => x.key === templateKey);
    if (!tpl) return;
    retentionApi
      .preview({
        trigger: tpl.trigger === 'LEVEL_UP' ? 'WELCOME' : tpl.trigger,
        body: tpl.body,
        userId: row.id,
      })
      .then((p) => setBody(p.body))
      .catch((err) => setError(apiErrorMessage(err, tErrors)));
  }, [templates, templateKey, row.id, tErrors]);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const { conversationId } = await messagingApi.openDm(row.id);
      await messagingApi.sendMessage(conversationId, body.trim());
      onSent(row.name);
    } catch (err) {
      setError(apiErrorMessage(err, tErrors));
    } finally {
      setSending(false);
    }
  }

  const usable = templates.filter((x) => x.trigger !== 'LEVEL_UP');

  return (
    <Dialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('escribirA', { nombre: row.name })}
      maxWidthClass="max-w-xl"
    >
      <div className="space-y-3" data-testid="escribir-dialogo">
        <label className="block text-sm font-semibold text-text">
          {t('plantilla')}
          <select
            value={templateKey}
            onChange={(e) => setTemplateKey(e.target.value)}
            className="mt-1.5 h-10 w-full rounded-lg border border-border bg-surface px-2 text-sm font-normal"
          >
            {usable.map((x) => (
              <option key={x.key} value={x.key}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold text-text">
          {t('mensaje')}
          <textarea
            rows={8}
            value={body}
            maxLength={4000}
            onChange={(e) => setBody(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-[15px] leading-relaxed font-normal"
          />
        </label>
        <p className="text-xs text-text-subtle">{t('escribirAyuda')}</p>
        {error ? (
          <p role="alert" className="text-sm font-semibold text-danger-700">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-xl px-4 text-sm font-semibold text-text-muted hover:underline"
          >
            {t('cancelar')}
          </button>
          <button
            type="button"
            disabled={sending || !body.trim()}
            onClick={() => void send()}
            className="h-10 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {sending ? t('enviando') : t('enviar')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
