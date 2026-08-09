'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Administración de la MEMBRESÍA (página pública /unete):
 *   - Planes: precio, periodicidad, precio tachado, días de prueba, orden.
 *   - Página: activo, headline, grupo de acceso concedido, precios individuales
 *     por curso (lo que costarían por separado) y testimonial opcional.
 * Todos los selectores usan datos reales (grupos y cursos del tenant).
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { accessGroupsApi, type AccessGroupListItem } from '@/lib/access-groups';
import { adminStripeApi } from '@/lib/admin-stripe';
import { authStorage } from '@/lib/auth-storage';
import { coursesApi, type Course } from '@/lib/courses';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCents } from '@/lib/i18n/format';
import {
  membershipAdminApi,
  type MembershipAdminPlan,
  type MembershipConfig,
} from '@/lib/membership';

/** "999.5" o "999,5" (unidades de la moneda) → céntimos int, o null si no parsea. */
function amountToCents(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function centsToAmount(cents: number | null): string {
  if (cents === null) return '';
  return (cents / 100).toFixed(2).replace(/\.00$/, '');
}

/**
 * Monedas del selector, curadas a monedas de DOS decimales: los importes se
 * guardan en céntimos y se formatean dividiendo entre 100 (una moneda
 * cero-decimal tipo JPY necesitaría otro tratamiento).
 */
const CURRENCY_OPTIONS = ['eur', 'usd', 'gbp', 'mxn', 'cop', 'ars', 'pen', 'brl'];

/** Periodicidades habituales del selector; la API admite cualquier 1..12. */
const INTERVAL_PRESETS = [1, 3, 6, 12];

interface PlanDraft {
  name: string;
  intervalMonths: number;
  currency: string;
  amountRaw: string;
  compareAtRaw: string;
  trialDays: string;
  isFeatured: boolean;
}

const EMPTY_DRAFT: PlanDraft = {
  name: '',
  intervalMonths: 1,
  currency: 'eur',
  amountRaw: '',
  compareAtRaw: '',
  trialDays: '0',
  isFeatured: false,
};

export default function MembresiaAdminPage() {
  const t = useTranslations('adminMonetizacion.membership');
  const tInterval = useTranslations('adminMonetizacion.interval');
  const tSub = useTranslations('adminMonetizacion.subscription');
  const tErrors = useTranslations('errors');
  const [plans, setPlans] = useState<MembershipAdminPlan[] | null>(null);
  const [config, setConfig] = useState<MembershipConfig | null>(null);
  const [groups, setGroups] = useState<AccessGroupListItem[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null mientras carga; false si ni el tenant ni el fallback global tienen
  // Stripe configurado — la config de planes/página se guarda igual, pero el
  // checkout real de /unete fallará hasta que se configure.
  const [stripeReady, setStripeReady] = useState<boolean | null>(null);

  // Alta/edición de plan
  const [draft, setDraft] = useState<PlanDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Config editable
  const [headline, setHeadline] = useState('');
  const [subheadline, setSubheadline] = useState('');
  const [accessGroupId, setAccessGroupId] = useState('');
  const [showCourses, setShowCourses] = useState(true);
  // Drip del trial: nº de lecciones visibles por curso durante la prueba ('' = 0 = sin límite).
  const [trialLessonLimit, setTrialLessonLimit] = useState('5');
  const [active, setActive] = useState(false);
  const [priceByCourse, setPriceByCourse] = useState<Record<string, string>>({});
  const [tQuote, setTQuote] = useState('');
  const [tAuthor, setTAuthor] = useState('');
  const [tRole, setTRole] = useState('');

  function token(): string | null {
    return authStorage.getAccessToken();
  }

  useEffect(() => {
    const bearer = token();
    if (!bearer) return;
    void (async () => {
      try {
        const [planList, cfg, groupRes, courseList] = await Promise.all([
          membershipAdminApi.listPlans(bearer),
          membershipAdminApi.getConfig(bearer),
          accessGroupsApi.list(bearer),
          coursesApi.list({ status: 'PUBLISHED' }),
        ]);
        setPlans(planList);
        setGroups(groupRes.groups);
        setCourses(courseList);
        applyConfig(cfg);
      } catch (e) {
        setError(apiErrorMessage(e, tErrors));
      }
      // Aviso proactivo, no bloqueante: guardar planes/página no depende de
      // Stripe, pero el checkout real de /unete sí — mejor avisar aquí que
      // dejar que el admin lo descubra cuando un alumno intente pagar.
      try {
        const stripe = await adminStripeApi.get();
        setStripeReady(stripe.hasTenantConfig || stripe.hasGlobalFallback);
      } catch {
        setStripeReady(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyConfig(cfg: MembershipConfig) {
    setConfig(cfg);
    setHeadline(cfg.headline);
    setSubheadline(cfg.subheadline ?? '');
    setAccessGroupId(cfg.accessGroupId ?? '');
    setShowCourses(cfg.showCourses);
    setTrialLessonLimit(String(cfg.trialLessonLimit ?? 5));
    setActive(cfg.active);
    setTQuote(cfg.testimonialQuote ?? '');
    setTAuthor(cfg.testimonialAuthor ?? '');
    setTRole(cfg.testimonialRole ?? '');
    const prices: Record<string, string> = {};
    for (const p of cfg.coursePrices) prices[p.courseId] = centsToAmount(p.amountCents);
    setPriceByCourse(prices);
  }

  const publicUrl = useMemo(
    () => (typeof window !== 'undefined' ? `${window.location.origin}/unete` : '/unete'),
    [],
  );

  // Los precios de referencia por curso no llevan moneda propia: en /unete se
  // muestran junto a los planes, así que heredan la del primer plan del tenant.
  const refCurrency = (plans?.[0]?.currency ?? 'eur').toUpperCase();

  const intervalOptionLabel = (n: number): string => {
    if (n === 1) return tInterval('monthly');
    if (n === 3) return tInterval('quarterly');
    if (n === 6) return tInterval('semiannual');
    if (n === 12) return tInterval('annual');
    return tInterval('everyMonths', { months: n });
  };

  /** Nombre largo de la periodicidad del plan (antes `intervalDescription`). */
  const subscriptionLabel = (n: number): string => {
    if (n === 12) return tSub('annual');
    if (n === 6) return tSub('semiannual');
    if (n === 3) return tSub('quarterly');
    if (n === 1) return tSub('monthly');
    return tSub('everyMonths', { months: n });
  };

  async function savePlan() {
    const bearer = token();
    if (!bearer) return;
    const amountCents = amountToCents(draft.amountRaw);
    if (!draft.name.trim() || amountCents === null) {
      setError(t('planNeedsNamePrice'));
      return;
    }
    const compareAtCents = draft.compareAtRaw.trim() ? amountToCents(draft.compareAtRaw) : null;
    const trialDays = Number(draft.trialDays) || 0;
    setBusy(true);
    setError(null);
    try {
      const input = {
        name: draft.name.trim(),
        intervalMonths: draft.intervalMonths,
        currency: draft.currency,
        amountCents,
        compareAtCents,
        trialDays,
        isFeatured: draft.isFeatured,
      };
      if (editingId) await membershipAdminApi.updatePlan(bearer, editingId, input);
      else await membershipAdminApi.createPlan(bearer, input);
      setPlans(await membershipAdminApi.listPlans(bearer));
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
      setNotice(editingId ? t('planUpdated') : t('planCreated'));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function togglePlanActive(plan: MembershipAdminPlan) {
    const bearer = token();
    if (!bearer) return;
    setBusy(true);
    try {
      await membershipAdminApi.updatePlan(bearer, plan.id, { active: !plan.active });
      setPlans(await membershipAdminApi.listPlans(bearer));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function removePlan(plan: MembershipAdminPlan) {
    const bearer = token();
    if (!bearer) return;
    setBusy(true);
    try {
      await membershipAdminApi.deletePlan(bearer, plan.id);
      setPlans(await membershipAdminApi.listPlans(bearer));
      setNotice(t('planDeleted'));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(plan: MembershipAdminPlan) {
    setEditingId(plan.id);
    setDraft({
      name: plan.name,
      intervalMonths: plan.intervalMonths,
      currency: plan.currency,
      amountRaw: centsToAmount(plan.amountCents),
      compareAtRaw: centsToAmount(plan.compareAtCents),
      trialDays: String(plan.trialDays),
      isFeatured: plan.isFeatured,
    });
  }

  async function saveConfig() {
    const bearer = token();
    if (!bearer) return;
    // Límite del trial: exigir un número explícito — un campo vacío NO debe
    // guardarse en silencio como 0 (= sin límite, justo lo contrario de lo que
    // el admin probablemente quería).
    const parsedTrialLimit = Number.parseInt(trialLessonLimit, 10);
    if (!Number.isFinite(parsedTrialLimit) || parsedTrialLimit < 0 || parsedTrialLimit > 1000) {
      setError(t('trialLimitInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const coursePrices = Object.entries(priceByCourse)
        .map(([courseId, amount]) => ({ courseId, amountCents: amountToCents(amount) }))
        .filter((x): x is { courseId: string; amountCents: number } => x.amountCents !== null);
      const updated = await membershipAdminApi.updateConfig(bearer, {
        active,
        // Literal, NO traducido: este valor se PERSISTE y lo leen los visitantes
        // de la página pública, no el admin. Traducirlo guardaría el titular en
        // el idioma de la UI de quien guardó (un admin en inglés dejaría
        // «Become a member» a un público español). Coincide con el default de la
        // columna en el schema (`MembershipConfig.headline`).
        headline: headline.trim() || 'Hazte miembro',
        subheadline: subheadline.trim() || null,
        accessGroupId: accessGroupId || null,
        showCourses,
        trialLessonLimit: parsedTrialLimit,
        coursePrices,
        testimonialQuote: tQuote.trim() || null,
        testimonialAuthor: tAuthor.trim() || null,
        testimonialRole: tRole.trim() || null,
      });
      applyConfig(updated);
      setNotice(t('configSaved'));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-text-muted">
            {t('publicIntro')}{' '}
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-brand-700 hover:underline"
            >
              {publicUrl}
            </a>
          </p>
        </div>
        <Badge variant={config?.active ? 'success' : 'muted'}>
          {config?.active ? t('badgeActive') : t('badgeInactive')}
        </Badge>
      </div>

      {stripeReady === false ? (
        <p className="rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700">
          {t.rich('stripeWarning', {
            link: (chunks) => (
              <Link href="/admin/configuracion" className="font-semibold underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : null}

      {error && (
        <p className="rounded-lg border border-danger-500/40 bg-danger-50 px-3 py-2 text-sm text-danger-700">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success-700">
          {notice}
        </p>
      )}

      {/* ── Planes ── */}
      <Card>
        <CardHeader>
          <CardTitle>{t('plansTitle')}</CardTitle>
          <CardDescription>{t('plansDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {plans === null ? (
            <p className="text-sm text-text-muted">{t('loading')}</p>
          ) : plans.length === 0 ? (
            <p className="text-sm text-text-muted">{t('plansEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {plans.map((plan) => (
                <li
                  key={plan.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {plan.name}{' '}
                      {plan.isFeatured ? <Badge variant="success">{t('featured')}</Badge> : null}{' '}
                      {!plan.active ? <Badge variant="muted">{t('inactive')}</Badge> : null}
                    </p>
                    <p className="text-sm text-text-muted">
                      {subscriptionLabel(plan.intervalMonths)} ·{' '}
                      {plan.compareAtCents ? (
                        <span className="line-through">
                          {formatCents(plan.compareAtCents, plan.currency.toUpperCase())}
                        </span>
                      ) : null}{' '}
                      <strong>{formatCents(plan.amountCents, plan.currency.toUpperCase())}</strong>
                      {plan.trialDays > 0
                        ? ` · ${t('trialDaysSuffix', { days: plan.trialDays })}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => startEdit(plan)}>
                      {t('edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void togglePlanActive(plan)}
                    >
                      {plan.active ? t('deactivate') : t('activate')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void removePlan(plan)}
                    >
                      {t('delete')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Alta / edición */}
          <div className="grid gap-3 rounded-xl border border-border bg-surface-2 p-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-name">{t('nameLabel')}</Label>
              <Input
                id="plan-name"
                placeholder={t('namePlaceholder')}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-interval">{t('intervalLabel')}</Label>
              <Select
                id="plan-interval"
                value={String(draft.intervalMonths)}
                onChange={(e) => setDraft({ ...draft, intervalMonths: Number(e.target.value) })}
              >
                {(INTERVAL_PRESETS.includes(draft.intervalMonths)
                  ? INTERVAL_PRESETS
                  : [...INTERVAL_PRESETS, draft.intervalMonths].sort((a, b) => a - b)
                ).map((n) => (
                  <option key={n} value={String(n)}>
                    {intervalOptionLabel(n)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-currency">{t('currencyLabel')}</Label>
              <Select
                id="plan-currency"
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
              >
                {(CURRENCY_OPTIONS.includes(draft.currency)
                  ? CURRENCY_OPTIONS
                  : [...CURRENCY_OPTIONS, draft.currency]
                ).map((c) => (
                  <option key={c} value={c}>
                    {c.toUpperCase()}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-amount">
                {t('priceLabel', { currency: draft.currency.toUpperCase() })}
              </Label>
              <Input
                id="plan-amount"
                inputMode="decimal"
                placeholder="999"
                value={draft.amountRaw}
                onChange={(e) => setDraft({ ...draft, amountRaw: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-compare">{t('compareAtLabel')}</Label>
              <Input
                id="plan-compare"
                inputMode="decimal"
                placeholder="1188"
                value={draft.compareAtRaw}
                onChange={(e) => setDraft({ ...draft, compareAtRaw: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-trial">{t('trialDaysLabel')}</Label>
              <Input
                id="plan-trial"
                inputMode="numeric"
                value={draft.trialDays}
                onChange={(e) => setDraft({ ...draft, trialDays: e.target.value })}
              />
            </div>
            <div className="flex items-end gap-2 pb-1">
              <Switch
                id="plan-featured"
                checked={draft.isFeatured}
                onCheckedChange={(v) => setDraft({ ...draft, isFeatured: v })}
              />
              <Label htmlFor="plan-featured">{t('featuredLabel')}</Label>
            </div>
            <div className="flex items-center gap-2 md:col-span-2">
              <Button disabled={busy} onClick={() => void savePlan()}>
                {editingId ? t('saveChanges') : t('createPlan')}
              </Button>
              {editingId ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingId(null);
                    setDraft(EMPTY_DRAFT);
                  }}
                >
                  {t('cancelEdit')}
                </Button>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Página pública ── */}
      <Card>
        <CardHeader>
          <CardTitle>{t('configTitle')}</CardTitle>
          <CardDescription>{t('configDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Switch id="page-active" checked={active} onCheckedChange={setActive} />
            <Label htmlFor="page-active">{t('pageActiveLabel')}</Label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-headline">{t('headlineLabel')}</Label>
              <Input
                id="cfg-headline"
                value={headline}
                placeholder={t('defaultHeadline')}
                onChange={(e) => setHeadline(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-group">{t('groupLabel')}</Label>
              <Select
                id="cfg-group"
                value={accessGroupId}
                onChange={(e) => setAccessGroupId(e.target.value)}
              >
                <option value="">{t('noGroupOption')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="cfg-sub">{t('subheadlineLabel')}</Label>
              <Textarea
                id="cfg-sub"
                rows={2}
                placeholder={t('subheadlinePlaceholder')}
                value={subheadline}
                onChange={(e) => setSubheadline(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch id="cfg-courses" checked={showCourses} onCheckedChange={setShowCourses} />
            <Label htmlFor="cfg-courses">{t('showCoursesLabel')}</Label>
          </div>

          <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface-2 p-4">
            <Label htmlFor="cfg-trial-limit">{t('trialLimitLabel')}</Label>
            <div className="flex items-center gap-3">
              <Input
                id="cfg-trial-limit"
                type="number"
                min={0}
                max={1000}
                className="w-28"
                value={trialLessonLimit}
                onChange={(e) => setTrialLessonLimit(e.target.value)}
              />
              <p className="text-sm text-text-muted">{t('trialLimitHelp')}</p>
            </div>
          </div>

          {showCourses && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-4">
              <p className="text-sm font-semibold">{t('coursePricesTitle')}</p>
              {courses.length === 0 ? (
                <p className="text-sm text-text-muted">{t('noCoursesPublished')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {courses.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm">{c.title}</span>
                      <div className="flex items-center gap-1">
                        <Input
                          className="w-28 text-right"
                          inputMode="decimal"
                          placeholder="—"
                          value={priceByCourse[c.id] ?? ''}
                          onChange={(e) =>
                            setPriceByCourse((prev) => ({ ...prev, [c.id]: e.target.value }))
                          }
                        />
                        <span className="text-sm text-text-muted">{refCurrency}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="grid gap-3 rounded-xl border border-border bg-surface-2 p-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="cfg-tquote">{t('testimonialQuoteLabel')}</Label>
              <Textarea
                id="cfg-tquote"
                rows={3}
                value={tQuote}
                onChange={(e) => setTQuote(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-tauthor">{t('testimonialAuthorLabel')}</Label>
              <Input
                id="cfg-tauthor"
                value={tAuthor}
                onChange={(e) => setTAuthor(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-trole">{t('testimonialRoleLabel')}</Label>
              <Input id="cfg-trole" value={tRole} onChange={(e) => setTRole(e.target.value)} />
            </div>
          </div>

          <div>
            <Button disabled={busy} onClick={() => void saveConfig()}>
              {t('saveConfig')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
