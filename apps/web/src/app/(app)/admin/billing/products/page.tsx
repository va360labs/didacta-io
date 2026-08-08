'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Panel admin · Productos de pago (mod.billing).
 *
 * Vincula cursos del tenant a `Stripe Price IDs` para que el botón
 * "Comprar curso" del catálogo (`/cursos/[slug]`) abra Checkout. Tras pago,
 * el bridge `BillingLearningBridge` matricula al alumno automáticamente.
 *
 * Reglas:
 *   - mod.billing es CE (open-core), NO requiere `<EeGate>`. Sí requiere rol
 *     `tenant_admin` o `super_admin` — el JwtAuthGuard del backend lo aplica.
 *   - El admin DEBE crear el `Product` y `Price` en su dashboard de Stripe
 *     primero. Aquí sólo pegamos el `price_xxx` ya creado.
 *   - El backend valida contra Stripe que el price exista y esté activo
 *     antes de persistir el vínculo (cachea unitAmount y currency).
 */

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatCurrency, formatDateTime } from '@/lib/i18n/format';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { billingApi, type BillingProduct } from '@/modules/billing';
import { coursesApi, type Course } from '@/lib/courses';

const PRICE_ID_PATTERN = /^price_[A-Za-z0-9]+$/;

/** unitAmount en céntimos + currency ISO-4217 → moneda formateada según el locale activo. */
function fmtPrice(unitAmount: number, currency: string): string {
  try {
    return formatCurrency(unitAmount / 100, currency.toUpperCase());
  } catch {
    return `${(unitAmount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Error de acción, con marca aparte para el caso "Stripe sin configurar" (CTA a Administración → Pagos). */
interface ActionError {
  message: string;
  stripeMissing: boolean;
}

function toActionError(e: unknown, fallback: string, tErrors: TranslatorLike): ActionError {
  if (e instanceof ApiHttpError) {
    return {
      message: apiErrorMessage(e, tErrors),
      stripeMissing: e.code === 'BILLING_STRIPE_CONFIG_MISSING',
    };
  }
  return { message: fallback, stripeMissing: false };
}

function ActionErrorMessage({ error }: { error: ActionError }) {
  const t = useTranslations('adminPagos');
  return (
    <p className="mt-3 text-sm text-danger-700">
      {error.message}
      {error.stripeMissing ? (
        <>
          {' '}
          <Link href="/admin/configuracion" className="font-semibold underline">
            {t('billing.stripeMissingCta')}
          </Link>
          .
        </>
      ) : null}
    </p>
  );
}

export default function AdminBillingProductsPage() {
  const t = useTranslations('adminPagos');
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('billing.title')}</h1>
        <p className="text-text-muted">
          {t.rich('billing.subtitle', {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </header>

      <BillingProductsPanel />
    </div>
  );
}

function BillingProductsPanel() {
  const t = useTranslations('adminPagos');
  const tErrors = useTranslations('errors');
  const [products, setProducts] = useState<BillingProduct[] | null>(null);
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  // Form alta
  const [courseId, setCourseId] = useState('');
  const [stripePriceId, setStripePriceId] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    void (async () => {
      try {
        const [productsRes, coursesRes] = await Promise.all([
          billingApi.listProducts(token),
          coursesApi.list({ status: 'PUBLISHED' }),
        ]);
        setProducts(productsRes.products);
        setCourses(coursesRes);
      } catch (e) {
        setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('billing.loadError'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshProducts() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const fresh = await billingApi.listProducts(token);
      setProducts(fresh.products);
    } catch {
      // Silencioso: el último error ya se muestra al usuario.
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!courseId || !stripePriceId) return;
    if (!PRICE_ID_PATTERN.test(stripePriceId.trim())) {
      setActionError({
        message: t('billing.priceIdFormatError'),
        stripeMissing: false,
      });
      return;
    }
    setCreating(true);
    setActionError(null);
    setActionInfo(null);
    try {
      const { product } = await billingApi.createProduct(token, courseId, stripePriceId.trim());
      setProducts((prev) => (prev ? [product, ...prev] : [product]));
      setCourseId('');
      setStripePriceId('');
      setActionInfo(t('billing.createdInfo', { title: courseTitle(courses, product.courseId, t) }));
    } catch (e) {
      setActionError(toActionError(e, t('billing.createError'), tErrors));
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(p: BillingProduct) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setActionError(null);
    setActionInfo(null);
    try {
      const { product } = await billingApi.updateProduct(token, p.id, { active: !p.active });
      setProducts((prev) =>
        prev ? prev.map((it) => (it.id === product.id ? product : it)) : prev,
      );
    } catch (e) {
      setActionError(toActionError(e, t('billing.toggleError'), tErrors));
    }
  }

  async function handleChangePrice(p: BillingProduct) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    const next = window.prompt(
      t('billing.changePricePrompt', { title: courseTitle(courses, p.courseId, t) }),
      p.stripePriceId,
    );
    if (!next || next.trim() === p.stripePriceId) return;
    if (!PRICE_ID_PATTERN.test(next.trim())) {
      setActionError({
        message: t('billing.priceIdPrefixError'),
        stripeMissing: false,
      });
      return;
    }
    setActionError(null);
    setActionInfo(null);
    try {
      const { product } = await billingApi.updateProduct(token, p.id, {
        stripePriceId: next.trim(),
      });
      setProducts((prev) =>
        prev ? prev.map((it) => (it.id === product.id ? product : it)) : prev,
      );
      setActionInfo(
        t('billing.priceUpdatedInfo', { price: fmtPrice(product.unitAmount, product.currency) }),
      );
    } catch (e) {
      setActionError(toActionError(e, t('billing.changePriceError'), tErrors));
    }
  }

  async function handleDelete(p: BillingProduct) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (!window.confirm(t('billing.deleteConfirm', { title: courseTitle(courses, p.courseId, t) })))
      return;
    setActionError(null);
    setActionInfo(null);
    try {
      await billingApi.deleteProduct(token, p.id);
      setProducts((prev) => (prev ? prev.filter((it) => it.id !== p.id) : prev));
      setActionInfo(t('billing.deletedInfo'));
    } catch (e) {
      setActionError(toActionError(e, t('billing.deleteError'), tErrors));
    }
  }

  // Cursos disponibles para alta: PUBLISHED y aún sin producto.
  const availableCourses = useMemo(() => {
    if (!courses || !products) return courses ?? [];
    const linked = new Set(products.map((p) => p.courseId));
    return courses.filter((c) => !linked.has(c.id));
  }, [courses, products]);

  if (products === null && courses === null && !error) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-danger-700">{error}</p>
        </CardContent>
      </Card>
    );
  }

  const list = products ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Form alta */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="plus" size={18} />
            {t('billing.formTitle')}
          </CardTitle>
          <CardDescription>
            {t.rich('billing.formHelp', {
              strong: (chunks) => <strong>{chunks}</strong>,
              code: (chunks) => <code>{chunks}</code>,
              link: (chunks) => (
                <a
                  href="https://dashboard.stripe.com/products"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-700 underline"
                >
                  {chunks}
                </a>
              ),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="courseId">{t('billing.courseLabel')}</Label>
              <select
                id="courseId"
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
                disabled={creating || availableCourses.length === 0}
                className="border-border bg-surface-1 focus:border-brand-500 focus:ring-brand-500/20 h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2"
              >
                <option value="">
                  {availableCourses.length === 0
                    ? t('billing.allCoursesLinked')
                    : t('billing.selectCoursePh')}
                </option>
                {availableCourses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="stripePriceId">{t('billing.priceIdLabel')}</Label>
              <Input
                id="stripePriceId"
                placeholder={t('billing.priceIdPh')}
                value={stripePriceId}
                onChange={(e) => setStripePriceId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={creating}
              />
            </div>
            <Button type="submit" disabled={creating || !courseId || !stripePriceId.trim()}>
              {creating ? t('billing.creatingCta') : t('billing.linkCta')}
            </Button>
          </form>
          {actionError ? <ActionErrorMessage error={actionError} /> : null}
          {actionInfo ? <p className="mt-3 text-sm text-success-700">{actionInfo}</p> : null}
        </CardContent>
      </Card>

      {/* Lista */}
      {list.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-text-muted">
            {t('billing.emptyList')}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {list.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              courseTitle={courseTitle(courses, p.courseId, t)}
              onToggleActive={() => handleToggleActive(p)}
              onChangePrice={() => handleChangePrice(p)}
              onDelete={() => handleDelete(p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductRow({
  product,
  courseTitle,
  onToggleActive,
  onChangePrice,
  onDelete,
}: {
  product: BillingProduct;
  courseTitle: string;
  onToggleActive: () => void;
  onChangePrice: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('adminPagos');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Icon name="book" size={18} />
          <span>{courseTitle}</span>
          {product.active ? (
            <Badge className="bg-success-600 text-white">{t('billing.activeBadge')}</Badge>
          ) : (
            <Badge variant="outline">{t('billing.inactiveBadge')}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {t('billing.linkedAt', { date: formatDateTime(product.createdAt) })}
          {product.updatedAt !== product.createdAt
            ? ` · ${t('billing.updatedAt', { date: formatDateTime(product.updatedAt) })}`
            : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <div>
            <dt className="text-text-muted">{t('billing.priceLabel')}</dt>
            <dd className="font-mono font-semibold">
              {fmtPrice(product.unitAmount, product.currency)}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-text-muted">{t('billing.priceIdLabel')}</dt>
            <dd className="break-all font-mono text-xs">{product.stripePriceId}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={onChangePrice}>
            <Icon name="edit" size={16} />
            {t('billing.changePriceCta')}
          </Button>
          <Button type="button" variant="secondary" onClick={onToggleActive}>
            {product.active ? t('billing.deactivateCta') : t('billing.reactivateCta')}
          </Button>
          <Button type="button" variant="ghost" onClick={onDelete}>
            <Icon name="trash" size={16} />
            {t('billing.unlinkCta')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function courseTitle(courses: Course[] | null, courseId: string, t: TranslatorLike): string {
  if (!courses) return courseId;
  return (
    courses.find((c) => c.id === courseId)?.title ??
    t('billing.courseFallback', { id: courseId.slice(0, 8) })
  );
}
