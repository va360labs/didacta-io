'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/select';
import { RestrictionDialog } from '@/components/restriction-shield';
import {
  accessGroupsApi,
  type AccessGroupListItem,
  type CourseCatalogItem,
} from '@/lib/access-groups';
import { adminUsersApi, ASSIGNABLE_ROLES, type AssignableRole } from '@/lib/admin-users';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  formatCents,
  formatDate as fmtDate,
  formatDateTime as fmtDateTime,
  formatNumber,
} from '@/lib/i18n/format';
import { labelOr, type TranslatorLike } from '@/lib/i18n/labels';
import { learningApi } from '@/lib/learning';
import { dossierApi, type UserDossier } from '@/lib/dossier';

/**
 * Expediente de un usuario, visible solo para admins dentro de `/u/[id]`.
 *
 * Va aquí y no en una página aparte a propósito: la regla del proyecto prohíbe
 * dos caminos al mismo destino, y ya existía el histórico de `/inicio` contra
 * `/comunidad`. Con esto, pulsar un nombre desde cualquier sección lleva
 * siempre al mismo sitio; lo que cambia es cuánto ve quien mira.
 */

const TABS = [
  { id: 'resumen', labelKey: 'dossier.tabResumen' },
  { id: 'compras', labelKey: 'dossier.tabCompras' },
  { id: 'formacion', labelKey: 'dossier.tabFormacion' },
  { id: 'actividad', labelKey: 'dossier.tabActividad' },
  { id: 'mensajes', labelKey: 'dossier.tabMensajes' },
  { id: 'acceso', labelKey: 'dossier.tabAcceso' },
  { id: 'sanciones', labelKey: 'dossier.tabSanciones' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Fecha corta del expediente (dd/mm/aaaa), tolerante a null. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return fmtDate(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return fmtDateTime(iso);
}

/** Céntimos → moneda, tolerante a null. */
function formatMoney(cents: number | null, currency = 'eur'): string {
  if (cents === null) return '—';
  return formatCents(cents, currency.toUpperCase());
}

/** «3 meses», «2 años»: la antigüedad se lee mejor que 847 días. */
function formatMembership(days: number, t: TranslatorLike): string {
  if (days < 1) return t('dossier.membershipToday');
  if (days < 30) return t('dossier.membershipDays', { days });
  const months = Math.floor(days / 30);
  if (months < 12) return t('dossier.membershipMonths', { months });
  const years = Math.floor(days / 365);
  const restMonths = Math.floor((days % 365) / 30);
  return restMonths > 0
    ? t('dossier.membershipYearsMonths', { years, months: restMonths })
    : t('dossier.membershipYears', { years });
}

export function UserDossierPanel({
  userId,
  initialTab,
}: {
  userId: string;
  initialTab?: string | null;
}) {
  const t = useTranslations('cuentaComponentes');
  const tErrors = useTranslations('errors');
  const [data, setData] = useState<UserDossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(
    (TABS.find((t) => t.id === initialTab)?.id ?? 'resumen') as TabId,
  );
  const [moderating, setModerating] = useState(false);

  const load = () => {
    dossierApi
      .get(userId)
      .then(setData)
      .catch((err) => setError(apiErrorMessage(err, tErrors)));
  };

  useEffect(() => {
    let aborted = false;
    setData(null);
    setError(null);
    dossierApi
      .get(userId)
      .then((d) => {
        if (!aborted) setData(d);
      })
      .catch((err) => {
        if (!aborted) {
          setError(apiErrorMessage(err, tErrors));
        }
      });
    return () => {
      aborted = true;
    };
    // `tErrors` es estable entre renders y queda fuera de deps a propósito: no
    // tiene sentido recargar el expediente por un cambio de traductor.
  }, [userId]);

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-text-muted">{error}</CardContent>
      </Card>
    );
  }

  if (!data) return <div className="skeleton h-64 w-full" />;

  const activeRestrictions = data.restrictions.filter((r) => r.active);

  return (
    <section className="space-y-4" data-testid="user-dossier">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-text">{t('dossier.title')}</h2>
        <button
          type="button"
          onClick={() => setModerating(true)}
          className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg-subtle"
          data-testid="open-moderation"
        >
          {t('dossier.moderate')}
        </button>
      </div>

      {activeRestrictions.length > 0 ? (
        <Card>
          <CardContent className="border-l-4 border-l-red-500 p-4">
            <p className="text-sm font-semibold text-red-700 dark:text-red-400">
              {t('dossier.sanctioned', {
                scopes: activeRestrictions.map((r) => r.scopeLabels.join(', ')).join(' · '),
              })}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {activeRestrictions[0]!.expiresAt
                ? t('dossier.untilDateTime', {
                    date: formatDateTime(activeRestrictions[0]!.expiresAt),
                  })
                : t('dossier.permanent')}{' '}
              · {t('dossier.quotedReason', { reason: activeRestrictions[0]!.reason })}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            type="button"
            onClick={() => setTab(tabDef.id)}
            data-testid={`dossier-tab-${tabDef.id}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === tabDef.id
                ? 'border-brand-500 font-semibold text-brand-700'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </div>

      {tab === 'resumen' ? <ResumenTab d={data} /> : null}
      {tab === 'compras' ? <ComprasTab d={data} /> : null}
      {tab === 'formacion' ? <FormacionTab d={data} onChanged={load} /> : null}
      {tab === 'actividad' ? <ActividadTab d={data} /> : null}
      {tab === 'mensajes' ? <MensajesTab d={data} /> : null}
      {tab === 'acceso' ? <AccesoTab d={data} onChanged={load} /> : null}
      {tab === 'sanciones' ? <SancionesTab d={data} /> : null}

      {moderating ? (
        <RestrictionDialog
          userId={userId}
          userName={data.identity.name ?? data.identity.email}
          onClose={() => {
            setModerating(false);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-[11px] uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-0.5 font-display text-lg font-semibold text-text">{value}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-text-muted">{children}</p>;
}

/**
 * Antigüedad real: se cuenta desde la primera compra, no desde el alta.
 *
 * Muchas cuentas se crearon en la importación masiva mucho después de que la
 * persona comprara: quien compró semanas antes de tener cuenta parecería
 * llevar tres días siendo clienta.
 */
function antiguedadDias(d: UserDossier): number {
  if (!d.commerce.customerSince) return d.identity.membershipDays;
  const desdeCompra = Math.floor(
    (Date.now() - new Date(d.commerce.customerSince).getTime()) / 86_400_000,
  );
  return Math.max(desdeCompra, d.identity.membershipDays);
}

function ResumenTab({ d }: { d: UserDossier }) {
  const t = useTranslations('cuentaComponentes');
  const sub = d.commerce.subscriptions.find(
    (s) => s.status === 'ACTIVE' || s.status === 'TRIALING',
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('dossier.statSeniority')} value={formatMembership(antiguedadDias(d), t)} />
        <Stat
          label={t('dossier.statTotalPaid')}
          value={formatMoney(
            d.commerce.totalPaidCents +
              d.commerce.totalPaidExternalCents +
              d.commerce.totalStoreCents,
          )}
        />
        <Stat label={t('dossier.statCourses')} value={d.learning.enrollments.length} />
        <Stat label={t('dossier.statLastLogin')} value={formatDate(d.identity.lastLoginAt)} />
        <Stat label={t('dossier.statPosts')} value={d.activity.counts.posts} />
        <Stat label={t('dossier.statComments')} value={d.activity.counts.comments} />
        <Stat label={t('dossier.statMessages')} value={d.activity.counts.messages} />
        <Stat label={t('dossier.statTutorQuestions')} value={d.activity.counts.aiQuestions} />
      </div>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <Row label={t('dossier.rowEmail')} value={d.identity.email} />
          <Row
            label={t('dossier.rowStatus')}
            value={labelOr(t, `userStatus.${d.identity.status}`, d.identity.status)}
          />
          <Row label={t('dossier.rowRoles')} value={d.identity.roles.join(', ') || '—'} />
          <Row label={t('dossier.rowCreated')} value={formatDate(d.identity.createdAt)} />
          <Row
            label={t('dossier.rowSubscription')}
            value={
              sub
                ? `${sub.planName ?? t('dossier.planFallback')} · ${labelOr(
                    t,
                    `subStatus.${sub.status}`,
                    sub.status,
                  )}${
                    sub.currentPeriodEnd
                      ? ` · ${t('dossier.expiresDate', { date: formatDate(sub.currentPeriodEnd) })}`
                      : ''
                  }`
                : t('dossier.noActiveSub')
            }
          />
          {d.gamification ? (
            <Row
              label={t('dossier.rowPoints')}
              value={`${formatNumber(d.gamification.lifetimePoints)}${
                d.gamification.levelKey
                  ? ` · ${t('dossier.levelLabel', { level: d.gamification.levelKey })}`
                  : ''
              }`}
            />
          ) : null}
          {d.identity.externalSource ? (
            <Row label={t('dossier.rowOrigin')} value={d.identity.externalSource} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-border-soft pb-1.5 last:border-0">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text">{value}</span>
    </div>
  );
}

/** Pastilla del tipo de derecho: lo que decide si ese acceso caduca o no. */
function KindPill({ kind }: { kind: string }) {
  const t = useTranslations('cuentaComponentes');
  const variant =
    kind === 'LIFETIME'
      ? 'success'
      : kind === 'SUBSCRIPTION' || kind === 'TIMED'
        ? 'warning'
        : 'muted';
  return <Badge variant={variant}>{labelOr(t, `entitlementKind.${kind}`, kind)}</Badge>;
}

/**
 * Compras hechas en la tienda externa. Es el histórico de verdad: las ventas
 * dentro de Didacta son un puñado y todo lo demás se compró en la tienda.
 */
function TiendaExterna({ d }: { d: UserDossier }) {
  const t = useTranslations('cuentaComponentes');
  const pedidos = d.commerce.externalOrders;
  if (pedidos.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-text">
        {t('dossier.storePurchases', {
          count: pedidos.length,
          amount: formatMoney(d.commerce.totalPaidExternalCents),
        })}
        {d.commerce.customerSince ? (
          <span className="font-normal text-text-muted">
            {' '}
            · {t('dossier.customerSince', { date: formatDate(d.commerce.customerSince) })}
          </span>
        ) : null}
      </h3>
      <div className="space-y-2">
        {pedidos.map((o) => (
          <Card key={o.id}>
            <CardContent className="p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-text">
                    {o.products.join(' · ') || t('dossier.orderFallback', { id: o.externalId })}
                  </p>
                  <p className="text-xs text-text-muted">
                    {formatDate(o.paidAt ?? o.placedAt)} · {o.provider} #{o.externalId} ·{' '}
                    {labelOr(t, `wooStatus.${o.status}`, o.status)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <KindPill kind={o.entitlementKind} />
                  <span className="font-semibold text-text">
                    {formatMoney(o.paid ? o.totalAmount : null, o.currency)}
                  </span>
                </div>
              </div>

              {/* Solo los accesos con vigencia caducan por su cuenta: la tienda
                  no avisa de estos, así que se marcan aquí. */}
              {o.accessEndsAt ? (
                <p
                  className={`mt-1.5 text-xs ${
                    o.daysToExpiry !== null && o.daysToExpiry < 0
                      ? 'font-semibold text-red-600 dark:text-red-400'
                      : 'text-text-muted'
                  }`}
                >
                  {o.daysToExpiry !== null && o.daysToExpiry < 0
                    ? t('dossier.accessExpired', { date: formatDate(o.accessEndsAt) })
                    : o.daysToExpiry !== null
                      ? t('dossier.accessUntilDaysLeft', {
                          date: formatDate(o.accessEndsAt),
                          days: o.daysToExpiry,
                        })
                      : t('dossier.accessUntil', { date: formatDate(o.accessEndsAt) })}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * Compras que la tienda del centro empuja por API.
 *
 * Van ARRIBA y separadas de `TiendaExterna` a propósito: son dos historiales
 * distintos —esta tienda y el espejo de WooCommerce— y en una ficha de atención
 * al cliente mezclarlos sin decir de dónde sale cada fila es peor que enseñar
 * uno solo. Por eso cada bloque dice su origen.
 *
 * Es también el único sitio de la ficha donde hay una factura que abrir: el
 * documento lo sirve quien lo emitió, aquí solo se enlaza.
 */
function TiendaPropia({ d }: { d: UserDossier }) {
  const t = useTranslations('cuentaComponentes');
  const pedidos = d.commerce.storeOrders;
  if (pedidos.length === 0) return null;

  const origenes = [...new Set(pedidos.map((o) => o.source))].join(', ');

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-text">
        {t('dossier.ownStorePurchases', {
          count: pedidos.length,
          amount: formatMoney(d.commerce.totalStoreCents),
          source: origenes,
        })}
      </h3>
      <div className="space-y-2">
        {pedidos.map((o) => (
          <Card key={o.id}>
            <CardContent className="p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-text">
                    {o.lines.join(' · ') || t('dossier.orderFallback', { id: o.reference })}
                  </p>
                  <p className="text-xs text-text-muted">
                    {formatDate(o.placedAt)} · {o.source} #{o.reference} ·{' '}
                    {labelOr(t, `compras.estado.${o.status}`, o.status)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {o.invoiceUrl ? (
                    <a
                      href={o.invoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-semibold text-brand-700 underline"
                    >
                      {o.invoiceNumber
                        ? t('compras.factura', { numero: o.invoiceNumber })
                        : t('compras.facturaSinNumero')}
                    </a>
                  ) : (
                    <span className="text-xs text-text-muted">{t('compras.sinFactura')}</span>
                  )}
                  <span className="font-semibold text-text">
                    {formatMoney(o.amountCents, o.currency)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ComprasTab({ d }: { d: UserDossier }) {
  const t = useTranslations('cuentaComponentes');
  return (
    <div className="space-y-4">
      <TiendaPropia d={d} />
      <TiendaExterna d={d} />
      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">
          {t('dossier.subscriptionsHeading', { count: d.commerce.subscriptions.length })}
        </h3>
        {d.commerce.subscriptions.length === 0 ? (
          <Empty>{t('dossier.noSubscriptions')}</Empty>
        ) : (
          <div className="space-y-2">
            {d.commerce.subscriptions.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <p className="font-semibold text-text">
                      {s.planName ?? t('dossier.planFallback')}
                    </p>
                    <p className="text-xs text-text-muted">
                      {formatMoney(s.unitAmount, s.currency)} / {s.interval}
                      {s.currentPeriodEnd
                        ? ` · ${t('dossier.expiresDate', { date: formatDate(s.currentPeriodEnd) })}`
                        : ''}
                      {s.daysToRenewal !== null && s.daysToRenewal >= 0
                        ? ` ${t('dossier.inDays', { days: s.daysToRenewal })}`
                        : ''}
                      {s.cancelAtPeriodEnd ? ` · ${t('dossier.noRenew')}` : ''}
                      {s.trialEndsAt
                        ? ` · ${t('dossier.trialUntil', { date: formatDate(s.trialEndsAt) })}`
                        : ''}
                    </p>
                  </div>
                  <Badge variant={s.status === 'ACTIVE' ? 'success' : 'muted'}>
                    {labelOr(t, `subStatus.${s.status}`, s.status)}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {d.commerce.externalSubscriptions.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">
            {t('dossier.externalSubsHeading')}
          </h3>
          <div className="space-y-2">
            {d.commerce.externalSubscriptions.map((s, i) => (
              <Card key={`${s.provider}-${i}`}>
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <p className="font-semibold text-text">{s.productName ?? s.provider}</p>
                    <p className="text-xs text-text-muted">
                      {s.provider}
                      {s.currentPeriodEnd
                        ? ` · ${t('dossier.expiresDate', { date: formatDate(s.currentPeriodEnd) })}`
                        : ''}
                    </p>
                  </div>
                  <Badge variant={s.entitled ? 'success' : 'muted'}>{s.status}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">
          {t('dossier.purchasesHeading', {
            count: d.commerce.orders.length,
            amount: formatMoney(d.commerce.totalPaidCents),
          })}
        </h3>
        {d.commerce.orders.length === 0 ? (
          <Empty>{t('dossier.noPurchases')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs uppercase text-text-muted">
                <tr>
                  <th className="py-2">{t('dossier.colCourse')}</th>
                  <th className="py-2">{t('dossier.colAmount')}</th>
                  <th className="py-2">{t('dossier.colStatus')}</th>
                  <th className="py-2">{t('dossier.colDate')}</th>
                </tr>
              </thead>
              <tbody>
                {d.commerce.orders.map((o) => (
                  <tr key={o.id} className="border-t border-border-soft">
                    <td className="py-2">{o.courseTitle ?? '—'}</td>
                    <td className="py-2">{formatMoney(o.amountPaid, o.currency)}</td>
                    <td className="py-2">
                      <Badge variant={o.status === 'COMPLETED' ? 'success' : 'muted'}>
                        {labelOr(t, `orderStatus.${o.status}`, o.status)}
                      </Badge>
                    </td>
                    <td className="py-2 text-text-muted">
                      {formatDate(o.completedAt ?? o.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Pestaña de formación. Desde F5 (viaje 1) además de mostrar, ACTÚA: matrícula
 * directa en un curso, baja administrativa y gestión de grupos de acceso.
 *
 * Los dos catálogos (cursos publicados y grupos) se cargan best-effort: si el
 * módulo correspondiente está desactivado para el tenant, la API responde 403
 * y el selector simplemente no se muestra (mismo patrón que `TierCell` en el
 * listado de usuarios). Lo ya concedido se pinta igual, porque viene del
 * expediente y no depende del módulo activo.
 */
function FormacionTab({ d, onChanged }: { d: UserDossier; onChanged: () => void }) {
  const t = useTranslations('cuentaComponentes');
  const tErrors = useTranslations('errors');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [courseCatalog, setCourseCatalog] = useState<CourseCatalogItem[] | null>(null);
  const [groupCatalog, setGroupCatalog] = useState<AccessGroupListItem[] | null>(null);
  const [courseId, setCourseId] = useState('');
  const [groupId, setGroupId] = useState('');

  const token = () => authStorage.getAccessToken() ?? '';

  useEffect(() => {
    let aborted = false;
    accessGroupsApi
      .courseCatalog(token())
      .then((c) => {
        if (!aborted) setCourseCatalog(c);
      })
      .catch(() => undefined);
    accessGroupsApi
      .list(token())
      .then((r) => {
        if (!aborted) setGroupCatalog(r.groups);
      })
      .catch(() => undefined);
    return () => {
      aborted = true;
    };
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
      onChanged();
    } catch (e) {
      setErr(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(null);
    }
  };

  // Solo tiene sentido ofrecer lo que aún no tiene: cursos sin matrícula viva
  // y grupos donde no está. Una matrícula CANCELLED sí se re-ofrece (reactiva).
  const enrolledCourseIds = new Set(
    d.learning.enrollments.filter((e) => e.status !== 'CANCELLED').map((e) => e.courseId),
  );
  const availableCourses = (courseCatalog ?? []).filter((c) => !enrolledCourseIds.has(c.id));
  const memberGroupIds = new Set(d.accessGroups.map((g) => g.groupId));
  const availableGroups = (groupCatalog ?? []).filter((g) => !memberGroupIds.has(g.id));

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">
          {t('dossier.coursesHeading', { count: d.learning.enrollments.length })}
        </h3>
        {d.learning.enrollments.length === 0 ? (
          <Empty>{t('dossier.noEnrollments')}</Empty>
        ) : (
          <div className="space-y-2">
            {d.learning.enrollments.map((e) => (
              <Card key={e.id}>
                <CardContent className="p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="font-semibold text-text">{e.courseTitle ?? e.courseId}</p>
                      <Badge
                        variant={
                          e.status === 'ACTIVE'
                            ? 'success'
                            : e.status === 'COMPLETED'
                              ? 'muted'
                              : 'warning'
                        }
                      >
                        {labelOr(t, `enrollmentStatus.${e.status}`, e.status)}
                      </Badge>
                      <Badge variant="muted">
                        {labelOr(t, `enrollmentSource.${e.source}`, e.source)}
                      </Badge>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-text-muted">
                        {e.progressPercent}% ·{' '}
                        {t('dossier.sinceDate', { date: formatDate(e.enrolledAt) })}
                        {e.completedAt
                          ? ` · ${t('dossier.completedDate', { date: formatDate(e.completedAt) })}`
                          : ''}
                      </span>
                      {e.status !== 'CANCELLED' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          title={e.source === 'GROUP' ? t('dossier.groupSourceHint') : undefined}
                          onClick={() =>
                            void run(
                              `unenroll-${e.id}`,
                              () => learningApi.cancelByAdmin(e.id),
                              t('dossier.unenrolledMsg'),
                            )
                          }
                          data-testid={`dossier-unenroll-${e.courseId}`}
                        >
                          {t('dossier.unenroll')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-subtle">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${Math.min(100, Math.max(0, e.progressPercent))}%` }}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {availableCourses.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <NativeSelect
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              className="w-auto min-w-[220px]"
              data-testid="dossier-enroll-select"
            >
              <option value="">{t('dossier.enrollPlaceholder')}</option>
              {availableCourses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </NativeSelect>
            <Button
              size="sm"
              disabled={busy !== null || !courseId}
              onClick={() =>
                void run(
                  'enroll',
                  async () => {
                    await learningApi.enrollByAdmin(d.identity.id, courseId);
                    setCourseId('');
                  },
                  t('dossier.enrolledMsg'),
                )
              }
              data-testid="dossier-enroll-submit"
            >
              {t('dossier.enroll')}
            </Button>
          </div>
        ) : null}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">
          {t('dossier.groupsHeading', { count: d.accessGroups.length })}
        </h3>
        {d.accessGroups.length === 0 ? (
          <Empty>{t('dossier.noGroups')}</Empty>
        ) : (
          <div className="space-y-2">
            {d.accessGroups.map((g) => (
              <Card key={g.groupId}>
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="font-semibold text-text">{g.name}</p>
                    {g.source === 'TIER' ? (
                      <Badge variant="muted">{t('dossier.byTier')}</Badge>
                    ) : null}
                    {g.source === 'MEMBERSHIP' ? (
                      <Badge variant="muted">{t('dossier.byMembership')}</Badge>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-text-muted">
                      {t('dossier.sinceDate', { date: formatDate(g.grantedAt) })}
                    </span>
                    {g.source !== 'TIER' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            `ungroup-${g.groupId}`,
                            () => accessGroupsApi.revokeMember(token(), g.groupId, d.identity.id),
                            t('dossier.ungroupedMsg'),
                          )
                        }
                        data-testid={`dossier-ungroup-${g.slug}`}
                      >
                        {t('dossier.removeFromGroup')}
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {availableGroups.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <NativeSelect
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-auto min-w-[220px]"
              data-testid="dossier-group-select"
            >
              <option value="">{t('dossier.addGroupPlaceholder')}</option>
              {availableGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </NativeSelect>
            <Button
              size="sm"
              disabled={busy !== null || !groupId}
              onClick={() =>
                void run(
                  'group',
                  async () => {
                    await accessGroupsApi.assignMembers(token(), groupId, [d.identity.id]);
                    setGroupId('');
                  },
                  t('dossier.groupedMsg'),
                )
              }
              data-testid="dossier-group-submit"
            >
              {t('dossier.addGroup')}
            </Button>
          </div>
        ) : null}
        <p className="mt-1.5 text-xs text-text-muted">{t('dossier.groupsHint')}</p>
        {msg ? <p className="text-sm text-green-700 dark:text-green-400">{msg}</p> : null}
        {err ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {err}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">
            {t('dossier.certificatesHeading', { count: d.learning.certificates.length })}
          </h3>
          {d.learning.certificates.length === 0 ? (
            <Empty>{t('dossier.noCertificates')}</Empty>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.learning.certificates.map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span className="font-mono text-xs">{c.number}</span>
                  <span className="text-text-muted">
                    {formatDate(c.issuedAt)}
                    {c.revokedAt ? ` · ${t('dossier.revoked')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">
            {t('dossier.attendanceHeading', { count: d.learning.liveAttendance.length })}
          </h3>
          {d.learning.liveAttendance.length === 0 ? (
            <Empty>{t('dossier.noAttendance')}</Empty>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.learning.liveAttendance.map((a) => (
                <li key={a.sessionId} className="flex justify-between gap-2">
                  <span className="text-text-muted">{formatDate(a.joinedAt)}</span>
                  <span>
                    {a.present
                      ? t('dossier.minutesShort', { minutes: a.minutes ?? 0 })
                      : t('dossier.absent')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {d.learning.quizAttempts.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">
            {t('dossier.quizAttemptsHeading', { count: d.learning.quizAttempts.length })}
          </h3>
          <ul className="space-y-1 text-sm">
            {d.learning.quizAttempts.map((a) => (
              <li key={a.id} className="flex justify-between gap-2">
                <span className="text-text-muted">{formatDate(a.submittedAt)}</span>
                <span>
                  {a.scorePercent !== null ? `${a.scorePercent}%` : '—'}
                  {a.passed === true
                    ? ` · ${t('dossier.passed')}`
                    : a.passed === false
                      ? ` · ${t('dossier.notPassed')}`
                      : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ActividadTab({ d }: { d: UserDossier }) {
  const t = useTranslations('cuentaComponentes');
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={t('dossier.statPosts')} value={d.activity.counts.posts} />
        <Stat label={t('dossier.statComments')} value={d.activity.counts.comments} />
        <Stat label={t('dossier.statReactions')} value={d.activity.counts.reactions} />
        <Stat label={t('dossier.statLessonComments')} value={d.activity.counts.lessonComments} />
        <Stat label={t('dossier.statResources')} value={d.activity.counts.resources} />
        <Stat label={t('dossier.statAiQuestions')} value={d.activity.counts.aiQuestions} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">{t('dossier.recentPosts')}</h3>
        {d.activity.posts.length === 0 ? (
          <Empty>{t('dossier.noPosts')}</Empty>
        ) : (
          <div className="space-y-2">
            {d.activity.posts.map((p) => (
              <Card key={p.id}>
                <CardContent className="p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    {p.title ? <span className="font-semibold text-text">{p.title}</span> : null}
                    <span className="text-xs text-text-muted">{formatDateTime(p.createdAt)}</span>
                    {p.hiddenAt ? <Badge variant="warning">{t('dossier.hidden')}</Badge> : null}
                    {p.deletedAt ? <Badge variant="muted">{t('dossier.deleted')}</Badge> : null}
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-text-muted">{p.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">{t('dossier.recentComments')}</h3>
        {d.activity.comments.length === 0 ? (
          <Empty>{t('dossier.noComments')}</Empty>
        ) : (
          <div className="space-y-2">
            {d.activity.comments.map((c) => (
              <Card key={c.id}>
                <CardContent className="p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-text-muted">{formatDateTime(c.createdAt)}</span>
                    {c.hiddenAt ? <Badge variant="warning">{t('dossier.hidden')}</Badge> : null}
                    {c.deletedAt ? <Badge variant="muted">{t('dossier.deleted')}</Badge> : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-text-muted">{c.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MensajesTab({ d }: { d: UserDossier }) {
  const t = useTranslations('cuentaComponentes');
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 text-xs text-text-muted">
          {t('dossier.messagesNotice')}
        </CardContent>
      </Card>

      <h3 className="text-sm font-semibold text-text">
        {t('dossier.messagesHeading', {
          total: d.messages.total,
          count: d.messages.recent.length,
        })}
      </h3>

      {d.messages.recent.length === 0 ? (
        <Empty>{t('dossier.noMessages')}</Empty>
      ) : (
        <div className="space-y-2">
          {d.messages.recent.map((m) => (
            <Card key={m.id}>
              <CardContent className="p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <Badge variant="muted">{m.conversationType}</Badge>
                  <span>{formatDateTime(m.createdAt)}</span>
                  {m.deletedAt ? (
                    <Badge variant="warning">{t('dossier.deletedByAuthor')}</Badge>
                  ) : null}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-text">{m.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pestaña de acceso. Además de mostrar, ACTÚA: suspender, reactivar, reenviar
 * el email de contraseña y gestionar roles.
 *
 * Estas acciones venían de `/admin/usuarios/[id]`, que ahora redirige aquí.
 * Consolidar la ruta sin traerse las acciones habría sido perder funcionalidad,
 * no simplificar.
 */
function AccesoTab({ d, onChanged }: { d: UserDossier; onChanged: () => void }) {
  const t = useTranslations('cuentaComponentes');
  const tErrors = useTranslations('errors');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<AssignableRole>('alumno');

  const run = async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
      onChanged();
    } catch (e) {
      setErr(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(null);
    }
  };

  const token = () => authStorage.getAccessToken() ?? '';
  const suspended = d.identity.status !== 'ACTIVE';
  const assignable = ASSIGNABLE_ROLES.filter((r) => !d.identity.roles.includes(r));

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            {suspended ? (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    'status',
                    () => adminUsersApi.setStatus(token(), d.identity.id, 'ACTIVE'),
                    t('dossier.reactivatedMsg'),
                  )
                }
                data-testid="reactivate-user"
              >
                {t('dossier.reactivate')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    'status',
                    () => adminUsersApi.setStatus(token(), d.identity.id, 'SUSPENDED'),
                    t('dossier.suspendedMsg'),
                  )
                }
                data-testid="suspend-user"
              >
                {t('dossier.suspend')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  'resend',
                  () => adminUsersApi.resendInvite(token(), d.identity.id),
                  t('dossier.emailSentMsg'),
                )
              }
            >
              {t('dossier.resendPassword')}
            </Button>
          </div>
          <p className="text-xs text-text-muted">{t('dossier.suspendHint')}</p>
          {msg ? <p className="text-sm text-green-700 dark:text-green-400">{msg}</p> : null}
          {err ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {err}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <Row
            label={t('dossier.rowStatus')}
            value={labelOr(t, `userStatus.${d.identity.status}`, d.identity.status)}
          />
          <Row
            label={t('dossier.rowEmailVerified')}
            value={d.identity.emailVerified ? t('dossier.yes') : t('dossier.no')}
          />
          <Row
            label={t('dossier.rowMfa')}
            value={d.identity.mfaEnabled ? t('dossier.enabled') : t('dossier.no')}
          />
          <Row label={t('dossier.rowLocale')} value={d.identity.locale} />
          <Row label={t('dossier.rowTimezone')} value={d.identity.timezone} />
          <Row label={t('dossier.rowDocument')} value={d.identity.documentId ?? '—'} />
          <Row
            label={t('dossier.rowOnboarding')}
            value={formatDate(d.identity.onboardingCompletedAt)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="text-sm font-semibold text-text">{t('dossier.rolesHeading')}</h3>
          <div className="flex flex-wrap gap-2">
            {d.identity.roles.length === 0 ? (
              <span className="text-sm text-text-muted">{t('dossier.noRoles')}</span>
            ) : (
              d.identity.roles.map((r) => (
                <span
                  key={r}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
                >
                  {labelOr(t, `role.${r}`, r)}
                  {r !== 'super_admin' ? (
                    <button
                      type="button"
                      aria-label={t('dossier.removeRoleAria', { role: r })}
                      disabled={busy !== null}
                      onClick={() =>
                        void run('role', () =>
                          adminUsersApi.removeRole(token(), d.identity.id, r as AssignableRole),
                        )
                      }
                      className="text-text-muted hover:text-red-600"
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))
            )}
          </div>
          {assignable.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as AssignableRole)}
                className="w-auto"
              >
                {assignable.map((r) => (
                  <option key={r} value={r}>
                    {t(`role.${r}`)}
                  </option>
                ))}
              </NativeSelect>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void run('role', () => adminUsersApi.assignRole(token(), d.identity.id, newRole))
                }
              >
                {t('dossier.addRole')}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">{t('dossier.recentSessions')}</h3>
        {d.access.recentSessions.length === 0 ? (
          <Empty>{t('dossier.noSessions')}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs uppercase text-text-muted">
                <tr>
                  <th className="py-2">{t('dossier.colStart')}</th>
                  <th className="py-2">{t('dossier.colExpires')}</th>
                  <th className="py-2">{t('dossier.colIp')}</th>
                  <th className="py-2">{t('dossier.colDevice')}</th>
                </tr>
              </thead>
              <tbody>
                {d.access.recentSessions.map((s) => (
                  <tr key={s.id} className="border-t border-border-soft">
                    <td className="py-2">{formatDateTime(s.createdAt)}</td>
                    <td className="py-2 text-text-muted">{formatDateTime(s.expiresAt)}</td>
                    <td className="py-2 font-mono text-xs">{s.ip ?? '—'}</td>
                    <td className="max-w-[240px] truncate py-2 text-xs text-text-muted">
                      {s.userAgent ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {d.access.externalIdentities.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">
            {t('dossier.externalIdentities')}
          </h3>
          <ul className="space-y-1 text-sm">
            {d.access.externalIdentities.map((i, idx) => (
              <li key={`${i.provider}-${idx}`} className="flex justify-between gap-2">
                <span>
                  {i.provider} · <span className="text-text-muted">{i.issuer}</span>
                </span>
                <span className="text-text-muted">
                  {t('dossier.linkedDate', { date: formatDate(i.linkedAt) })}
                  {i.lastSeenAt
                    ? ` · ${t('dossier.lastSeenDate', { date: formatDate(i.lastSeenAt) })}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SancionesTab({ d }: { d: UserDossier }) {
  const t = useTranslations('cuentaComponentes');
  if (d.restrictions.length === 0) {
    return <Empty>{t('dossier.neverSanctioned')}</Empty>;
  }
  return (
    <div className="space-y-2">
      {d.restrictions.map((r) => (
        <Card key={r.id}>
          <CardContent className="p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-text">{r.scopeLabels.join(', ')}</span>
              <Badge variant={r.active ? 'warning' : 'muted'}>
                {r.active
                  ? t('dossier.sanctionActive')
                  : r.liftedAt
                    ? t('dossier.sanctionLifted')
                    : t('dossier.sanctionExpired')}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {formatDateTime(r.createdAt)}
              {r.createdByName ? ` · ${t('dossier.byName', { name: r.createdByName })}` : ''} ·{' '}
              {r.expiresAt
                ? t('dossier.untilDateTimeLower', { date: formatDateTime(r.expiresAt) })
                : t('dossier.permanentLower')}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-text-muted">
              {t('dossier.quotedReason', { reason: r.reason })}
            </p>
            {r.liftedAt ? (
              <p className="mt-1 text-xs text-text-muted">
                {t('dossier.liftedOn', { date: formatDateTime(r.liftedAt) })}
                {r.liftedByName ? ` ${t('dossier.byName', { name: r.liftedByName })}` : ''}
                {r.liftReason ? ` ${t('dossier.dashQuotedReason', { reason: r.liftReason })}` : ''}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
