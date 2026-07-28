'use client';

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

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  billingApi,
  formatPrice,
  syncWoocommercePrices,
  type BillingProduct,
  type WooSyncReport,
} from '@/modules/billing';
import { coursesApi, type Course } from '@/lib/courses';

const PRICE_ID_PATTERN = /^price_[A-Za-z0-9]+$/;

export default function AdminBillingProductsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold tracking-tight">Pagos · Productos Stripe</h1>
        <p className="text-text-muted">
          Vincula cursos del tenant a un <code className="font-mono">Stripe Price ID</code>. El
          botón &laquo;Comprar curso&raquo; del catálogo abrirá Checkout y, tras pago, el alumno
          quedará matriculado automáticamente.
        </p>
      </header>

      <BillingProductsPanel />
    </div>
  );
}

function BillingProductsPanel() {
  const [products, setProducts] = useState<BillingProduct[] | null>(null);
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncReport, setSyncReport] = useState<WooSyncReport | null>(null);

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
        setError(
          e instanceof ApiHttpError
            ? e.message
            : 'No se pudo cargar el panel de pagos. Verifica tu sesión y rol.',
        );
      }
    })();
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
      setActionError(
        'El Stripe Price ID debe empezar por "price_" y solo contener letras y números.',
      );
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
      setActionInfo(`Producto creado para el curso ${courseTitle(courses, product.courseId)}.`);
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError
          ? e.message
          : 'No se pudo crear el producto. Revisa que el price_id exista y esté activo en Stripe.',
      );
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
      setActionError(e instanceof ApiHttpError ? e.message : 'No se pudo cambiar el estado.');
    }
  }

  async function handleChangePrice(p: BillingProduct) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    const next = window.prompt(
      `Nuevo Stripe Price ID para "${courseTitle(courses, p.courseId)}":`,
      p.stripePriceId,
    );
    if (!next || next.trim() === p.stripePriceId) return;
    if (!PRICE_ID_PATTERN.test(next.trim())) {
      setActionError('El Stripe Price ID debe empezar por "price_".');
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
      setActionInfo(`Price actualizado: ${formatPrice(product.unitAmount, product.currency)}.`);
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? e.message : 'No se pudo cambiar el price. Verifica Stripe.',
      );
    }
  }

  async function handleDelete(p: BillingProduct) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    if (
      !window.confirm(
        `¿Desvincular "${courseTitle(courses, p.courseId)}" de Stripe? Las órdenes históricas se conservan; el botón "Comprar curso" dejará de aparecer.`,
      )
    )
      return;
    setActionError(null);
    setActionInfo(null);
    try {
      await billingApi.deleteProduct(token, p.id);
      setProducts((prev) => (prev ? prev.filter((it) => it.id !== p.id) : prev));
      setActionInfo('Producto desvinculado.');
    } catch (e) {
      setActionError(e instanceof ApiHttpError ? e.message : 'No se pudo desvincular el producto.');
    }
  }

  async function handleSyncWoo() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setSyncing(true);
    setActionError(null);
    setActionInfo(null);
    setSyncReport(null);
    try {
      const report = await syncWoocommercePrices(token);
      setSyncReport(report);
      if (!report.tiendaConectada) {
        setActionError(
          'No hay ninguna tienda WooCommerce verificada. Conéctala en Integraciones → Conexiones de pago.',
        );
      } else {
        const cambios = report.aplicados.filter((a) => a.accion !== 'sin-cambios').length;
        setActionInfo(
          cambios === 0
            ? 'Los precios ya estaban al día con la tienda.'
            : `${cambios} precio(s) actualizados desde la tienda.`,
        );
        setProducts((await billingApi.listProducts(token)).products);
      }
    } catch (e) {
      setActionError(
        e instanceof ApiHttpError ? e.message : 'No se pudo sincronizar con la tienda.',
      );
    } finally {
      setSyncing(false);
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
      {/* Sincronización con la tienda: los cursos que se venden sueltos en
          WooCommerce toman de allí su precio. Los packs de varios cursos se
          ignoran (son la membresía, que se gobierna desde Didacta). */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="download-cloud" size={18} />
            Traer precios de la tienda
          </CardTitle>
          <CardDescription>
            Trae el precio de cada curso que se vende <strong>suelto</strong> en tu tienda
            WooCommerce, con su descuento si la oferta está activa. Los packs de varios cursos no se
            tocan: esos son la membresía y se configuran en Didacta. Se puede repetir cuando
            quieras: solo cambia lo que haya cambiado en la tienda.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button type="button" onClick={handleSyncWoo} disabled={syncing}>
            {syncing ? 'Sincronizando…' : 'Sincronizar precios'}
          </Button>
          {syncReport ? (
            <div className="space-y-3 text-sm">
              {syncReport.aplicados.length > 0 ? (
                <div>
                  <p className="font-semibold text-text">Precios aplicados</p>
                  <ul className="mt-1 space-y-1">
                    {syncReport.aplicados.map((a) => (
                      <li key={a.curso} className="text-text-muted">
                        <span className="text-text">{a.curso}</span> ·{' '}
                        {formatPrice(a.importeCents, 'eur')}
                        {a.antesCents ? ` (antes ${formatPrice(a.antesCents, 'eur')})` : ''} ·{' '}
                        {a.accion}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {syncReport.sinEmparejar.length > 0 ? (
                <div>
                  <p className="font-semibold text-text">Sin emparejar</p>
                  <ul className="mt-1 space-y-1">
                    {syncReport.sinEmparejar.map((x) => (
                      <li key={x.producto} className="text-text-muted">
                        <span className="text-text">{x.producto}</span> — {x.motivo}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {syncReport.packsIgnorados.length > 0 ? (
                <div>
                  <p className="font-semibold text-text">Productos que venden varios cursos</p>
                  <p className="text-xs text-text-muted">
                    No fijan precio individual. Los packs grandes son la membresía; los de dos o
                    tres cursos puede que vendan uno principal con algún extra de regalo — en ese
                    caso dale el precio a mano al curso que corresponda.
                  </p>
                  <ul className="mt-1 space-y-1">
                    {syncReport.packsIgnorados.map((x) => (
                      <li key={x.producto} className="text-text-muted">
                        <span className="text-text">{x.producto}</span>
                        {x.importeCents ? ` · ${formatPrice(x.importeCents, 'eur')}` : ''} ·{' '}
                        {x.cursos} cursos
                        {x.cursosAfectados.length > 0 && x.cursos <= 3
                          ? `: ${x.cursosAfectados.join(', ')}`
                          : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Form alta */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="plus" size={18} />
            Vincular un curso a un Stripe Price
          </CardTitle>
          <CardDescription>
            Antes de añadirlo aquí, crea un <strong>Product</strong> y un <strong>Price</strong> en{' '}
            <a
              href="https://dashboard.stripe.com/products"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-700 underline"
            >
              tu panel de Stripe
            </a>{' '}
            (modo test o live según tu configuración) y copia el <code>price_id</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="courseId">Curso</Label>
              <select
                id="courseId"
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
                disabled={creating || availableCourses.length === 0}
                className="border-border bg-surface-1 focus:border-brand-500 focus:ring-brand-500/20 h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2"
              >
                <option value="">
                  {availableCourses.length === 0
                    ? 'Todos los cursos publicados ya están vinculados'
                    : '— Selecciona un curso —'}
                </option>
                {availableCourses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="stripePriceId">Stripe Price ID</Label>
              <Input
                id="stripePriceId"
                placeholder="price_1AbC2dEfGhIj…"
                value={stripePriceId}
                onChange={(e) => setStripePriceId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={creating}
              />
            </div>
            <Button type="submit" disabled={creating || !courseId || !stripePriceId.trim()}>
              {creating ? 'Creando…' : 'Vincular'}
            </Button>
          </form>
          {actionError ? <p className="mt-3 text-sm text-danger-700">{actionError}</p> : null}
          {actionInfo ? <p className="mt-3 text-sm text-success-700">{actionInfo}</p> : null}
        </CardContent>
      </Card>

      {/* Lista */}
      {list.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-text-muted">
            Aún no has vinculado ningún curso a Stripe. Vincula uno arriba para que aparezca el
            botón &laquo;Comprar curso&raquo; en el catálogo público.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {list.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              courseTitle={courseTitle(courses, p.courseId)}
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Icon name="book" size={18} />
          <span>{courseTitle}</span>
          {product.active ? (
            <Badge className="bg-success-600 text-white">Activo</Badge>
          ) : (
            <Badge variant="outline">Inactivo</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Vinculado {new Date(product.createdAt).toLocaleString('es-ES')}
          {product.updatedAt !== product.createdAt
            ? ` · actualizado ${new Date(product.updatedAt).toLocaleString('es-ES')}`
            : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          <div>
            <dt className="text-text-muted">Precio</dt>
            <dd className="font-mono font-semibold">
              {formatPrice(product.unitAmount, product.currency)}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-text-muted">Stripe Price ID</dt>
            <dd className="break-all font-mono text-xs">{product.stripePriceId}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={onChangePrice}>
            <Icon name="edit" size={16} />
            Cambiar Price ID
          </Button>
          <Button type="button" variant="secondary" onClick={onToggleActive}>
            {product.active ? 'Desactivar' : 'Reactivar'}
          </Button>
          <Button type="button" variant="ghost" onClick={onDelete}>
            <Icon name="trash" size={16} />
            Desvincular
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function courseTitle(courses: Course[] | null, courseId: string): string {
  if (!courses) return courseId;
  return courses.find((c) => c.id === courseId)?.title ?? `Curso ${courseId.slice(0, 8)}`;
}
