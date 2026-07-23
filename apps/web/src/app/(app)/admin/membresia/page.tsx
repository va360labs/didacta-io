'use client';

/**
 * Administración de la MEMBRESÍA (página pública /unete):
 *   - Planes: precio, periodicidad, precio tachado, días de prueba, orden.
 *   - Página: activo, headline, grupo de acceso concedido, precios individuales
 *     por curso (lo que costarían por separado) y testimonial opcional.
 * Todos los selectores usan datos reales (grupos y cursos del tenant).
 */

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { accessGroupsApi, type AccessGroupListItem } from '@/lib/access-groups';
import { authStorage } from '@/lib/auth-storage';
import { coursesApi, type Course } from '@/lib/courses';
import {
  formatCents,
  intervalDescription,
  membershipAdminApi,
  type MembershipAdminPlan,
  type MembershipConfig,
} from '@/lib/membership';

/** "999.5" o "999,5" (euros) → céntimos int, o null si no parsea. */
function eurosToCents(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function centsToEuros(cents: number | null): string {
  if (cents === null) return '';
  return (cents / 100).toFixed(2).replace(/\.00$/, '');
}

interface PlanDraft {
  name: string;
  intervalMonths: number;
  amountEuros: string;
  compareAtEuros: string;
  trialDays: string;
  isFeatured: boolean;
}

const EMPTY_DRAFT: PlanDraft = {
  name: '',
  intervalMonths: 1,
  amountEuros: '',
  compareAtEuros: '',
  trialDays: '0',
  isFeatured: false,
};

export default function MembresiaAdminPage() {
  const [plans, setPlans] = useState<MembershipAdminPlan[] | null>(null);
  const [config, setConfig] = useState<MembershipConfig | null>(null);
  const [groups, setGroups] = useState<AccessGroupListItem[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Alta/edición de plan
  const [draft, setDraft] = useState<PlanDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Config editable
  const [headline, setHeadline] = useState('');
  const [subheadline, setSubheadline] = useState('');
  const [accessGroupId, setAccessGroupId] = useState('');
  const [showCourses, setShowCourses] = useState(true);
  const [active, setActive] = useState(false);
  const [priceByCourse, setPriceByCourse] = useState<Record<string, string>>({});
  const [tQuote, setTQuote] = useState('');
  const [tAuthor, setTAuthor] = useState('');
  const [tRole, setTRole] = useState('');

  function token(): string | null {
    return authStorage.getAccessToken();
  }

  useEffect(() => {
    const t = token();
    if (!t) return;
    void (async () => {
      try {
        const [planList, cfg, groupRes, courseList] = await Promise.all([
          membershipAdminApi.listPlans(t),
          membershipAdminApi.getConfig(t),
          accessGroupsApi.list(t),
          coursesApi.list({ status: 'PUBLISHED' }),
        ]);
        setPlans(planList);
        setGroups(groupRes.groups);
        setCourses(courseList);
        applyConfig(cfg);
      } catch (e) {
        setError(
          e instanceof ApiHttpError
            ? e.message
            : 'No pudimos cargar la configuración de membresía.',
        );
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
    setActive(cfg.active);
    setTQuote(cfg.testimonialQuote ?? '');
    setTAuthor(cfg.testimonialAuthor ?? '');
    setTRole(cfg.testimonialRole ?? '');
    const prices: Record<string, string> = {};
    for (const p of cfg.coursePrices) prices[p.courseId] = centsToEuros(p.amountCents);
    setPriceByCourse(prices);
  }

  const publicUrl = useMemo(
    () => (typeof window !== 'undefined' ? `${window.location.origin}/unete` : '/unete'),
    [],
  );

  async function savePlan() {
    const t = token();
    if (!t) return;
    const amountCents = eurosToCents(draft.amountEuros);
    if (!draft.name.trim() || amountCents === null) {
      setError('El plan necesita nombre y precio válido.');
      return;
    }
    const compareAtCents = draft.compareAtEuros.trim() ? eurosToCents(draft.compareAtEuros) : null;
    const trialDays = Number(draft.trialDays) || 0;
    setBusy(true);
    setError(null);
    try {
      const input = {
        name: draft.name.trim(),
        intervalMonths: draft.intervalMonths,
        amountCents,
        compareAtCents,
        trialDays,
        isFeatured: draft.isFeatured,
      };
      if (editingId) await membershipAdminApi.updatePlan(t, editingId, input);
      else await membershipAdminApi.createPlan(t, input);
      setPlans(await membershipAdminApi.listPlans(t));
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
      setNotice(editingId ? 'Plan actualizado.' : 'Plan creado.');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo guardar el plan.');
    } finally {
      setBusy(false);
    }
  }

  async function togglePlanActive(plan: MembershipAdminPlan) {
    const t = token();
    if (!t) return;
    setBusy(true);
    try {
      await membershipAdminApi.updatePlan(t, plan.id, { active: !plan.active });
      setPlans(await membershipAdminApi.listPlans(t));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo actualizar el plan.');
    } finally {
      setBusy(false);
    }
  }

  async function removePlan(plan: MembershipAdminPlan) {
    const t = token();
    if (!t) return;
    setBusy(true);
    try {
      await membershipAdminApi.deletePlan(t, plan.id);
      setPlans(await membershipAdminApi.listPlans(t));
      setNotice('Plan eliminado (o desactivado si ya tenía ventas).');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo eliminar el plan.');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(plan: MembershipAdminPlan) {
    setEditingId(plan.id);
    setDraft({
      name: plan.name,
      intervalMonths: plan.intervalMonths,
      amountEuros: centsToEuros(plan.amountCents),
      compareAtEuros: centsToEuros(plan.compareAtCents),
      trialDays: String(plan.trialDays),
      isFeatured: plan.isFeatured,
    });
  }

  async function saveConfig() {
    const t = token();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const coursePrices = Object.entries(priceByCourse)
        .map(([courseId, euros]) => ({ courseId, amountCents: eurosToCents(euros) }))
        .filter((x): x is { courseId: string; amountCents: number } => x.amountCents !== null);
      const updated = await membershipAdminApi.updateConfig(t, {
        active,
        headline: headline.trim() || 'Hazte miembro',
        subheadline: subheadline.trim() || null,
        accessGroupId: accessGroupId || null,
        showCourses,
        coursePrices,
        testimonialQuote: tQuote.trim() || null,
        testimonialAuthor: tAuthor.trim() || null,
        testimonialRole: tRole.trim() || null,
      });
      applyConfig(updated);
      setNotice('Configuración guardada.');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo guardar la configuración.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Membresía</h1>
          <p className="text-sm text-text-muted">
            Página pública de compra por suscripción:{' '}
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
          {config?.active ? 'Página activa' : 'Página desactivada'}
        </Badge>
      </div>

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
          <CardTitle>Planes</CardTitle>
          <CardDescription>
            Precio, periodicidad, precio tachado y días de prueba. El price de Stripe se crea solo
            en el primer pago (y se rota al cambiar el precio).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {plans === null ? (
            <p className="text-sm text-text-muted">Cargando…</p>
          ) : plans.length === 0 ? (
            <p className="text-sm text-text-muted">Aún no hay planes. Crea el primero abajo.</p>
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
                      {plan.isFeatured ? <Badge variant="success">Destacado</Badge> : null}{' '}
                      {!plan.active ? <Badge variant="muted">Inactivo</Badge> : null}
                    </p>
                    <p className="text-sm text-text-muted">
                      {intervalDescription(plan.intervalMonths)} ·{' '}
                      {plan.compareAtCents ? (
                        <span className="line-through">{formatCents(plan.compareAtCents)}</span>
                      ) : null}{' '}
                      <strong>{formatCents(plan.amountCents, plan.currency)}</strong>
                      {plan.trialDays > 0 ? ` · ${plan.trialDays} días de prueba` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => startEdit(plan)}>
                      Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void togglePlanActive(plan)}
                    >
                      {plan.active ? 'Desactivar' : 'Activar'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void removePlan(plan)}
                    >
                      Eliminar
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Alta / edición */}
          <div className="grid gap-3 rounded-xl border border-border bg-surface-2 p-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-name">Nombre</Label>
              <Input
                id="plan-name"
                placeholder="Anual"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-interval">Periodicidad</Label>
              <Select
                id="plan-interval"
                value={String(draft.intervalMonths)}
                onChange={(e) => setDraft({ ...draft, intervalMonths: Number(e.target.value) })}
              >
                <option value="1">Mensual</option>
                <option value="3">Trimestral</option>
                <option value="12">Anual</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-amount">Precio (€)</Label>
              <Input
                id="plan-amount"
                inputMode="decimal"
                placeholder="999"
                value={draft.amountEuros}
                onChange={(e) => setDraft({ ...draft, amountEuros: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-compare">Precio tachado (€, opcional)</Label>
              <Input
                id="plan-compare"
                inputMode="decimal"
                placeholder="1188"
                value={draft.compareAtEuros}
                onChange={(e) => setDraft({ ...draft, compareAtEuros: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="plan-trial">Días de prueba</Label>
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
              <Label htmlFor="plan-featured">Preseleccionado en la página</Label>
            </div>
            <div className="flex items-center gap-2 md:col-span-2">
              <Button disabled={busy} onClick={() => void savePlan()}>
                {editingId ? 'Guardar cambios' : 'Crear plan'}
              </Button>
              {editingId ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingId(null);
                    setDraft(EMPTY_DRAFT);
                  }}
                >
                  Cancelar edición
                </Button>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Página pública ── */}
      <Card>
        <CardHeader>
          <CardTitle>Página pública</CardTitle>
          <CardDescription>
            Contenido de /unete y qué concede la compra. El testimonial solo se muestra si lo
            rellenas (cita + autor).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Switch id="page-active" checked={active} onCheckedChange={setActive} />
            <Label htmlFor="page-active">Página de compra activa</Label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-headline">Título</Label>
              <Input
                id="cfg-headline"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-group">Grupo de acceso que concede</Label>
              <Select
                id="cfg-group"
                value={accessGroupId}
                onChange={(e) => setAccessGroupId(e.target.value)}
              >
                <option value="">— Sin grupo (no recomendado) —</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="cfg-sub">Subtítulo</Label>
              <Textarea
                id="cfg-sub"
                rows={2}
                placeholder="Desbloquea todos los cursos, actualizaciones y la comunidad."
                value={subheadline}
                onChange={(e) => setSubheadline(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch id="cfg-courses" checked={showCourses} onCheckedChange={setShowCourses} />
            <Label htmlFor="cfg-courses">Mostrar el catálogo de cursos en la página</Label>
          </div>

          {showCourses && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-2 p-4">
              <p className="text-sm font-semibold">
                Precio individual de referencia por curso (lo que cuestan por separado, p. ej. en
                va360.academy)
              </p>
              {courses.length === 0 ? (
                <p className="text-sm text-text-muted">No hay cursos publicados.</p>
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
                        <span className="text-sm text-text-muted">€</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="grid gap-3 rounded-xl border border-border bg-surface-2 p-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="cfg-tquote">Testimonial — cita (opcional)</Label>
              <Textarea
                id="cfg-tquote"
                rows={3}
                value={tQuote}
                onChange={(e) => setTQuote(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-tauthor">Autor</Label>
              <Input
                id="cfg-tauthor"
                value={tAuthor}
                onChange={(e) => setTAuthor(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-trole">Cargo</Label>
              <Input id="cfg-trole" value={tRole} onChange={(e) => setTRole(e.target.value)} />
            </div>
          </div>

          <div>
            <Button disabled={busy} onClick={() => void saveConfig()}>
              Guardar configuración
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
