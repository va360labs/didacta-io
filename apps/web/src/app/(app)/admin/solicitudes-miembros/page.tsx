'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { UserChip } from '@/components/user-chip';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import type { TranslatorLike } from '@/lib/i18n/labels';
import {
  decideMemberRequest,
  listMemberRequests,
  memberRenewalContext,
  rerunMemberLookup,
  sendMemberRenewalEmail,
  type MemberRequest,
  type MemberPurchaseMatch,
  type MemberSubscriptionMatch,
} from '@/lib/inscripcion';
import {
  classifySubscriptionStatus,
  formatAmount,
  paymentTiersApi,
  type PaymentTier,
} from '@/lib/payment-connections';
import { authStorage } from '@/lib/auth-storage';
import { RenewalEmailModal } from '@/components/renewal-email-modal';

/**
 * Panel admin de solicitudes de inscripción. Por cada solicitud PENDING muestra
 * el estado de su suscripción (consultada en TODAS las cuentas conectadas) y un
 * selector de TIER que viene PRESELECCIONADO si la suscripción detectada coincide
 * con un tier del catálogo (por nombre de plan); se puede cambiar a mano. Al
 * aprobar, se asigna ese tier (que, si está vinculado a un grupo, da el acceso).
 */
export default function SolicitudesMiembrosPage() {
  const t = useTranslations('adminUsuarios');
  const tErrors = useTranslations('errors');
  const [requests, setRequests] = useState<MemberRequest[] | null>(null);
  const [tiers, setTiers] = useState<PaymentTier[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // match null = email a un solicitante SIN suscripción detectada (sin enlace de renovación).
  const [emailFor, setEmailFor] = useState<{
    req: MemberRequest;
    match: MemberSubscriptionMatch | null;
  } | null>(null);
  // Email alternativo por solicitud, para mapear una suscripción registrada con otro email.
  const [mapEmail, setMapEmail] = useState<Record<string, string>>({});

  /**
   * Tier del catálogo cuyo nombre coincide con algún plan de una suscripción
   * VIGENTE (activa/en prueba/al corriente). Una baja o un impago NO preselecciona
   * el tier: el admin decide a mano si quiere darle acceso igualmente.
   */
  function suggestTierId(req: MemberRequest, catalog: PaymentTier[]): string {
    const planNames = (req.lookup?.results ?? [])
      .filter((m) => classifySubscriptionStatus(m.status).entitled)
      .map((m) => (m.planName ?? '').trim());
    const match = catalog.find((t) => planNames.includes(t.name.trim()));
    return match?.id ?? '';
  }

  async function load() {
    const t = authStorage.getAccessToken();
    if (!t) return;
    try {
      setError(null);
      const [reqs, catalog] = await Promise.all([
        listMemberRequests(t),
        paymentTiersApi
          .listCatalog(t)
          .then((r) => r.tiers)
          .catch(() => [] as PaymentTier[]),
      ]);
      setRequests(reqs);
      setTiers(catalog);
      // Preselección: el tier que coincide con la suscripción (salvo que el admin
      // ya hubiera tocado el selector de esa fila en esta sesión).
      setSelected((prev) => {
        const next = { ...prev };
        for (const r of reqs) {
          if (next[r.userId] === undefined) next[r.userId] = suggestTierId(r, catalog);
        }
        return next;
      });
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function rerun(userId: string, email?: string) {
    const t = authStorage.getAccessToken();
    if (!t) return;
    setBusy(`rerun:${userId}`);
    try {
      setError(null);
      await rerunMemberLookup(t, userId, email);
      await load();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(null);
    }
  }

  async function approve(req: MemberRequest) {
    const bearer = authStorage.getAccessToken();
    if (!bearer) return;
    setBusy(`approve:${req.userId}`);
    try {
      setError(null);
      const tierId = selected[req.userId] || null;
      // 1) Asigna el tier (emite el evento → reconcilia el grupo vinculado/acceso).
      if (tierId) await paymentTiersApi.assignUserTier(bearer, req.userId, tierId);
      // 2) Aprueba (ACTIVE + grupo por defecto + bienvenida).
      await decideMemberRequest(bearer, req.userId, 'approve');
      const tierName = tiers.find((x) => x.id === tierId)?.name;
      setNotice(
        tierName
          ? t('requests.approvedWithTier', { name: req.name ?? req.email, tier: tierName })
          : t('requests.approved', { name: req.name ?? req.email }),
      );
      await load();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(null);
    }
  }

  async function reject(req: MemberRequest) {
    const bearer = authStorage.getAccessToken();
    if (!bearer) return;
    if (!window.confirm(t('requests.rejectConfirm', { name: req.name ?? req.email }))) return;
    setBusy(`reject:${req.userId}`);
    try {
      setError(null);
      await decideMemberRequest(bearer, req.userId, 'reject');
      setNotice(t('requests.rejected', { name: req.name ?? req.email }));
      await load();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text">{t('requests.title')}</h1>
        <p className="text-text-muted">{t('requests.subtitle')}</p>
      </header>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-brand-500/30 bg-brand-50 px-4 py-3 text-sm text-brand-700">
          {notice}
        </div>
      )}

      {requests === null ? (
        <Skeleton className="h-32 w-full" />
      ) : requests.length === 0 ? (
        <p className="text-text-muted">{t('requests.empty')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {requests.map((r) => (
            <Card key={r.userId}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    <UserChip
                      userId={r.userId}
                      name={r.name}
                      email={r.email}
                      showAvatar={false}
                      size={20}
                      nameClassName="block truncate text-base"
                    />
                  </CardTitle>
                  <Button
                    variant="ghost"
                    onClick={() => void rerun(r.userId)}
                    disabled={busy === `rerun:${r.userId}`}
                  >
                    {busy === `rerun:${r.userId}`
                      ? t('requests.requerying')
                      : t('requests.requery')}
                  </Button>
                </div>
                <CardDescription>
                  {r.email}
                  {r.telegramId ? t('requests.telegramTag', { id: r.telegramId }) : ''}
                  {r.telegramInGroup === true
                    ? t('requests.inGroupTag')
                    : r.telegramInGroup === false
                      ? t('requests.notInGroupTag')
                      : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <SubscriptionBlock
                  request={r}
                  onRemind={(match) => setEmailFor({ req: r, match })}
                  onEmail={() => setEmailFor({ req: r, match: null })}
                />

                <PurchasesBlock request={r} />

                <MapSubscriptionRow
                  request={r}
                  value={mapEmail[r.userId] ?? ''}
                  busy={busy === `rerun:${r.userId}`}
                  onChange={(v) => setMapEmail((prev) => ({ ...prev, [r.userId]: v }))}
                  onSearch={() =>
                    void rerun(r.userId, (mapEmail[r.userId] ?? '').trim() || undefined)
                  }
                />

                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[14rem] flex-1">
                    <Label htmlFor={`tier-${r.userId}`}>{t('requests.tierLabel')}</Label>
                    <Select
                      id={`tier-${r.userId}`}
                      value={selected[r.userId] ?? ''}
                      onChange={(e) =>
                        setSelected((prev) => ({ ...prev, [r.userId]: e.target.value }))
                      }
                    >
                      <option value="">{t('requests.noTier')}</option>
                      {tiers.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.name}
                        </option>
                      ))}
                    </Select>
                    {selected[r.userId] && selected[r.userId] === suggestTierId(r, tiers) && (
                      <p className="mt-1 text-xs text-brand-700">{t('requests.preselected')}</p>
                    )}
                  </div>
                  <Button onClick={() => void approve(r)} disabled={busy === `approve:${r.userId}`}>
                    {busy === `approve:${r.userId}`
                      ? t('requests.approving')
                      : t('requests.approve')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void reject(r)}
                    disabled={busy === `reject:${r.userId}`}
                  >
                    {t('requests.reject')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {emailFor && (
        <RenewalEmailModal
          to={emailFor.req.email}
          productName={emailFor.match?.planName ?? null}
          unitAmount={emailFor.match?.unitAmount ?? null}
          currency={emailFor.match?.currency ?? null}
          loadContext={async () => {
            const bearer = authStorage.getAccessToken();
            if (!bearer) throw new Error(t('requests.noSession'));
            return memberRenewalContext(
              bearer,
              emailFor.req.userId,
              emailFor.match?.subscriptionId,
            );
          }}
          send={async (payload) => {
            const bearer = authStorage.getAccessToken();
            if (!bearer) throw new Error(t('requests.noSession'));
            return sendMemberRenewalEmail(bearer, emailFor.req.userId, payload);
          }}
          onClose={() => setEmailFor(null)}
          onSent={(msg) => {
            setEmailFor(null);
            setNotice(msg);
          }}
        />
      )}
    </div>
  );
}

/**
 * Fila para mapear la suscripción por OTRO email, cuando el miembro se registró con
 * un email pero pagó con otro. Re-consulta el lookup por ese email y lo persiste.
 */
function MapSubscriptionRow({
  request,
  value,
  busy,
  onChange,
  onSearch,
}: {
  request: MemberRequest;
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSearch: () => void;
}) {
  const t = useTranslations('adminUsuarios');
  const usedEmail = request.lookup?.email ?? null;
  const mapped = usedEmail && usedEmail.toLowerCase() !== request.email.toLowerCase();
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border bg-surface-2 p-3">
      {mapped ? (
        <p className="text-xs text-brand-700">
          {t.rich('requests.mappedNote', {
            email: usedEmail,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1">
          <Label htmlFor={`mapemail-${request.userId}`} className="text-xs text-text-muted">
            {t('requests.mapLabel')}
          </Label>
          <Input
            id={`mapemail-${request.userId}`}
            type="email"
            placeholder={t('requests.mapPlaceholder')}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) onSearch();
            }}
          />
        </div>
        <Button variant="secondary" onClick={onSearch} disabled={busy || !value.trim()}>
          {busy ? t('requests.searching') : t('requests.searchSubscription')}
        </Button>
      </div>
    </div>
  );
}

/** Bloque de estado de suscripción de una solicitud. */
function SubscriptionBlock({
  request,
  onRemind,
  onEmail,
}: {
  request: MemberRequest;
  onRemind: (match: MemberSubscriptionMatch) => void;
  /** Enviar un email al solicitante SIN suscripción detectada (sin enlace de renovación). */
  onEmail: () => void;
}) {
  const t = useTranslations('adminUsuarios');
  const lookup = request.lookup;
  if (!lookup || lookup.status === 'PENDING') {
    return (
      <p className="text-sm text-text-muted">
        {lookup?.status === 'PENDING' ? t('requests.lookupPending') : t('requests.lookupNotYet')}
      </p>
    );
  }
  if (lookup.status === 'ERROR') {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning-700">
        {lookup.error
          ? t('requests.lookupErrorDetail', { error: lookup.error })
          : t('requests.lookupError')}
      </div>
    );
  }
  const results = lookup.results ?? [];
  if (lookup.matchCount === 0 || results.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
        <span className="text-sm text-text-muted">{t('requests.noSubscription')}</span>
        <Button variant="ghost" size="sm" onClick={onEmail}>
          {t('requests.sendEmail')}
        </Button>
      </div>
    );
  }
  // ¿Alguna suscripción concede acceso hoy? Si todas son bajas/impagos, lo decimos
  // explícitamente (no es lo mismo que "sin suscripción").
  const hasEntitled = results.some((m) => classifySubscriptionStatus(m.status).entitled);
  return (
    <div
      className={
        hasEntitled
          ? 'rounded-lg border border-success/30 bg-success/5 px-3 py-2'
          : 'rounded-lg border border-warning/40 bg-warning/5 px-3 py-2'
      }
    >
      <p
        className={
          hasEntitled
            ? 'mb-1 text-sm font-medium text-success-700'
            : 'mb-1 text-sm font-medium text-warning-700'
        }
      >
        {hasEntitled
          ? t('requests.subEntitled', { count: results.length })
          : t('requests.subNotEntitled', { count: results.length })}
      </p>
      <ul className="flex flex-col gap-1">
        {results.map((m) => (
          <li
            key={m.subscriptionId}
            className="flex flex-wrap items-center justify-between gap-2 text-sm text-text"
          >
            <span>{describeMatch(m, t)}</span>
            <Button variant="ghost" onClick={() => onRemind(m)}>
              {t('requests.sendReminder')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Compras PUNTUALES (pedidos) del solicitante. Quien compró un "acceso lifetime"
 * no tiene suscripción viva: sin este bloque el bloque de arriba diría "sin
 * suscripción" y se rechazaría a un cliente que sí pagó. Solo se pinta si hay
 * compras (para no añadir ruido a las solicitudes normales).
 */
function PurchasesBlock({ request }: { request: MemberRequest }) {
  const t = useTranslations('adminUsuarios');
  const purchases = request.lookup?.purchases ?? [];
  if (purchases.length === 0) return null;
  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
      <p className="mb-1 text-sm font-medium text-brand-700">
        {t('requests.purchases', { count: purchases.length })}
      </p>
      <ul className="flex flex-col gap-1">
        {purchases.map((p) => (
          <li key={`${p.connectionId}:${p.orderId}`} className="text-sm text-text">
            {describePurchase(p)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Describe un pedido en una línea: nº · fecha · estado · importe — productos. */
function describePurchase(p: MemberPurchaseMatch): string {
  const date = p.createdAt ? new Date(p.createdAt) : null;
  const head = [
    p.orderNumber ? `#${p.orderNumber}` : `#${p.orderId}`,
    date && !Number.isNaN(date.getTime()) ? formatDate(date) : '',
    p.status,
    p.total !== null ? formatAmount(p.total, p.currency) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const products = p.products.length ? ` — ${p.products.join(', ')}` : '';
  return `${head}${products} (${p.connectionName})`;
}

function describeMatch(m: MemberSubscriptionMatch, t: TranslatorLike): string {
  const plan = m.planName ?? t('requests.planFallback');
  const { label } = classifySubscriptionStatus(m.status);
  const amount = m.unitAmount !== null ? ` · ${formatAmount(m.unitAmount, m.currency)}` : '';
  return `${plan} — ${label}${amount} (${m.connectionName})`;
}
