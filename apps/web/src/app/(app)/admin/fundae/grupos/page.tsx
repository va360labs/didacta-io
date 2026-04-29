'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { formatCents } from '@/lib/fundae-companies';
import {
  fundaeGroupsApi,
  STATUS_LABELS,
  TIPO_LABELS,
  MODALIDAD_LABELS,
  type CreateCostInput,
  type CreateGroupInput,
  type FundaeCost,
  type FundaeGroup,
  type GroupStatus,
  type Modalidad,
} from '@/lib/fundae-groups';

const STATUS_VARIANT: Record<GroupStatus, 'info' | 'success' | 'muted' | 'warning'> = {
  DRAFT: 'muted',
  ACTIVE: 'success',
  CLOSED: 'info',
  CANCELLED: 'warning',
};

/**
 * Vista admin de grupos bonificables Fundae (LMS-81).
 * Lista filtrable + alta + transiciones de estado + costes.
 */
export default function FundaeGruposPage() {
  const [groups, setGroups] = useState<FundaeGroup[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<GroupStatus | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState<{ group: FundaeGroup; costs: FundaeCost[] } | null>(null);

  async function reload() {
    try {
      setError(null);
      const list = await fundaeGroupsApi.list({
        status: statusFilter !== '' ? (statusFilter as GroupStatus) : undefined,
      });
      setGroups(list);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los grupos.');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  async function openDetail(g: FundaeGroup) {
    try {
      const [group, costs] = await Promise.all([
        fundaeGroupsApi.get(g.id),
        fundaeGroupsApi.listCosts(g.id),
      ]);
      setDetail({ group, costs });
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar el detalle.');
    }
  }

  async function handleTransition(id: string, action: 'start' | 'close' | 'cancel') {
    const labels = { start: 'iniciar', close: 'cerrar', cancel: 'cancelar' };
    if (!confirm(`¿Seguro que quieres ${labels[action]} este grupo?`)) return;
    try {
      await fundaeGroupsApi[action](id);
      await reload();
      if (detail?.group.id === id) {
        const [group, costs] = await Promise.all([
          fundaeGroupsApi.get(id),
          fundaeGroupsApi.listCosts(id),
        ]);
        setDetail({ group, costs });
      }
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'La transición no fue posible.');
    }
  }

  async function handleRemoveCost(groupId: string, costId: string) {
    if (!confirm('¿Eliminar este coste?')) return;
    try {
      await fundaeGroupsApi.removeCost(groupId, costId);
      const costs = await fundaeGroupsApi.listCosts(groupId);
      setDetail((prev) => (prev ? { ...prev, costs } : prev));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos eliminar el coste.');
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Grupos bonificables</h1>
          <p className="mt-1 max-w-3xl text-text-muted">
            Agrupación de participantes de una acción formativa vinculados a una empresa Fundae. El
            crédito consumido se debita del crédito de la empresa al cerrar.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setDetail(null);
            setShowForm((v) => !v);
          }}
        >
          <Icon name="plus" size={16} />
          {showForm ? 'Cerrar' : 'Nuevo grupo'}
        </Button>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="statusFilter">Estado</Label>
          <select
            id="statusFilter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as GroupStatus | '')}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">Todos</option>
            {(['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'] as const).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="secondary" onClick={() => void reload()}>
          <Icon name="arrow-right" size={14} />
          Actualizar
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showForm ? (
        <GroupForm
          onSaved={async (g) => {
            setShowForm(false);
            await reload();
            await openDetail(g);
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {detail ? (
        <GroupDetail
          group={detail.group}
          costs={detail.costs}
          onTransition={(action) => void handleTransition(detail.group.id, action)}
          onRemoveCost={(costId) => void handleRemoveCost(detail.group.id, costId)}
          onCostAdded={async () => {
            const costs = await fundaeGroupsApi.listCosts(detail.group.id);
            setDetail((prev) => (prev ? { ...prev, costs } : prev));
          }}
          onClose={() => setDetail(null)}
        />
      ) : null}

      {groups === null ? (
        <div className="space-y-3">
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-2xl font-semibold">Sin grupos registrados</h3>
            <p className="max-w-md text-text-muted">
              Crea el primer grupo bonificable vinculando una acción formativa a una empresa Fundae.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => (
            <Card key={g.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-text">
                      Grupo {g.numeroGrupo}
                    </span>
                    <Badge variant={STATUS_VARIANT[g.status]}>{STATUS_LABELS[g.status]}</Badge>
                    <Badge variant="muted">{MODALIDAD_LABELS[g.modalidad]}</Badge>
                  </div>
                  <p className="text-xs text-text-muted">
                    {new Date(g.fechaInicioPrevista).toLocaleDateString('es-ES')} →{' '}
                    {new Date(g.fechaFinPrevista).toLocaleDateString('es-ES')}
                  </p>
                  <p className="text-sm tabular-nums text-text-muted">
                    Crédito estimado: {formatCents(g.creditoEstimadoCents)} · consumido:{' '}
                    {formatCents(g.creditoConsumidoCents)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void openDetail(g)}
                  >
                    <Icon name="eye" size={13} />
                    Ver detalle
                  </Button>
                  {g.status === 'DRAFT' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleTransition(g.id, 'start')}
                    >
                      <Icon name="play" size={13} />
                      Iniciar
                    </Button>
                  ) : null}
                  {g.status === 'ACTIVE' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleTransition(g.id, 'close')}
                    >
                      <Icon name="check" size={13} />
                      Cerrar
                    </Button>
                  ) : null}
                  {g.status === 'DRAFT' || g.status === 'ACTIVE' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleTransition(g.id, 'cancel')}
                    >
                      <Icon name="alert" size={13} />
                      Cancelar
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

// ──────────────────── FORMULARIO ALTA ────────────────────

function GroupForm({
  onSaved,
  onCancel,
}: {
  onSaved: (g: FundaeGroup) => Promise<void>;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    setPending(true);
    setError(null);
    try {
      const creditoEur = Number(form.get('creditoEur') ?? 0);
      const dto: CreateGroupInput = {
        actionId: form.get('actionId')?.toString().trim() ?? '',
        companyId: form.get('companyId')?.toString().trim() ?? '',
        modalidad: (form.get('modalidad')?.toString() ?? 'PRESENCIAL') as Modalidad,
        fechaInicioPrevista: new Date(
          form.get('fechaInicioPrevista')?.toString() ?? '',
        ).toISOString(),
        fechaFinPrevista: new Date(form.get('fechaFinPrevista')?.toString() ?? '').toISOString(),
        creditoEstimadoCents: creditoEur > 0 ? Math.round(creditoEur * 100) : undefined,
        notas: form.get('notas')?.toString() || undefined,
      };
      const created = await fundaeGroupsApi.create(dto);
      await onSaved(created);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos crear el grupo.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nuevo grupo bonificable</CardTitle>
        <CardDescription>
          El grupo se crea en estado Borrador. Inicia la formación para activarlo (requiere
          antelación RLPT de 15 días y crédito disponible suficiente).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="actionId">
                ID Acción formativa <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="actionId"
                name="actionId"
                required
                placeholder="UUID de la acción"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="companyId">
                ID Empresa bonificada <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="companyId"
                name="companyId"
                required
                placeholder="UUID de la empresa"
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="modalidad">Modalidad</Label>
              <select
                id="modalidad"
                name="modalidad"
                defaultValue="PRESENCIAL"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {(['PRESENCIAL', 'TELEFORMACION', 'MIXTA'] as const).map((m) => (
                  <option key={m} value={m}>
                    {MODALIDAD_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fechaInicioPrevista">
                Fecha inicio prevista <span className="text-danger-700">*</span>
              </Label>
              <Input id="fechaInicioPrevista" name="fechaInicioPrevista" type="date" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fechaFinPrevista">
                Fecha fin prevista <span className="text-danger-700">*</span>
              </Label>
              <Input id="fechaFinPrevista" name="fechaFinPrevista" type="date" required />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="creditoEur">Crédito estimado (€)</Label>
              <Input
                id="creditoEur"
                name="creditoEur"
                type="number"
                step="0.01"
                min={0}
                placeholder="0,00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="notas">Notas internas</Label>
              <Textarea id="notas" name="notas" rows={2} maxLength={2000} />
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}

          <div className="flex items-center gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={pending}>
              {pending ? 'Creando…' : 'Crear grupo'}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ──────────────────── PANEL DETALLE ────────────────────

function GroupDetail({
  group,
  costs,
  onTransition,
  onRemoveCost,
  onCostAdded,
  onClose,
}: {
  group: FundaeGroup;
  costs: FundaeCost[];
  onTransition: (action: 'start' | 'close' | 'cancel') => void;
  onRemoveCost: (costId: string) => void;
  onCostAdded: () => Promise<void>;
  onClose: () => void;
}) {
  const isEditable = group.status === 'DRAFT' || group.status === 'ACTIVE';
  const [showCostForm, setShowCostForm] = useState(false);

  return (
    <Card className="border-l-4 border-l-primary">
      <CardHeader className="flex flex-row items-start justify-between pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            Grupo {group.numeroGrupo}
            <Badge variant={STATUS_VARIANT[group.status]}>{STATUS_LABELS[group.status]}</Badge>
          </CardTitle>
          <CardDescription>
            {MODALIDAD_LABELS[group.modalidad]} ·{' '}
            {new Date(group.fechaInicioPrevista).toLocaleDateString('es-ES')} →{' '}
            {new Date(group.fechaFinPrevista).toLocaleDateString('es-ES')}
          </CardDescription>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          <Icon name="alert" size={14} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <span className="text-text-muted">Crédito estimado:</span>{' '}
            <span className="font-semibold">{formatCents(group.creditoEstimadoCents)}</span>
          </div>
          <div>
            <span className="text-text-muted">Consumido:</span>{' '}
            <span className="font-semibold">{formatCents(group.creditoConsumidoCents)}</span>
          </div>
          <div>
            <span className="text-text-muted">Directo/Indirecto/Org:</span>{' '}
            <span className="font-mono text-xs">
              {formatCents(group.costsByTipo.DIRECTO)} / {formatCents(group.costsByTipo.INDIRECTO)}{' '}
              / {formatCents(group.costsByTipo.ORGANIZACION)}
            </span>
          </div>
        </div>

        {isEditable ? (
          <div className="flex flex-wrap gap-2 border-t border-border-soft pt-3">
            {group.status === 'DRAFT' ? (
              <Button type="button" size="sm" onClick={() => onTransition('start')}>
                <Icon name="play" size={13} />
                Iniciar grupo
              </Button>
            ) : null}
            {group.status === 'ACTIVE' ? (
              <Button type="button" size="sm" onClick={() => onTransition('close')}>
                <Icon name="check" size={13} />
                Cerrar grupo
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onTransition('cancel')}
            >
              <Icon name="alert" size={13} />
              Cancelar grupo
            </Button>
          </div>
        ) : null}

        <div className="space-y-2 border-t border-border-soft pt-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">Costes</h4>
            {isEditable ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setShowCostForm((v) => !v)}
              >
                <Icon name="plus" size={13} />
                Añadir coste
              </Button>
            ) : null}
          </div>

          {showCostForm ? (
            <CostForm
              groupId={group.id}
              onSaved={async () => {
                setShowCostForm(false);
                await onCostAdded();
              }}
              onCancel={() => setShowCostForm(false)}
            />
          ) : null}

          {costs.length === 0 ? (
            <p className="text-xs text-text-muted">Sin costes registrados.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-subtle">
                  <th className="pb-1 font-medium">Tipo</th>
                  <th className="pb-1 font-medium">Concepto</th>
                  <th className="pb-1 text-right font-medium">Importe</th>
                  {isEditable ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id} className="border-t border-border-soft">
                    <td className="py-1 pr-2">
                      <Badge variant="muted">{TIPO_LABELS[c.tipo]}</Badge>
                    </td>
                    <td className="py-1 pr-2">{c.concepto}</td>
                    <td className="py-1 text-right tabular-nums font-semibold">
                      {formatCents(c.amountCents)}
                    </td>
                    {isEditable ? (
                      <td className="py-1 pl-2">
                        <button
                          type="button"
                          onClick={() => onRemoveCost(c.id)}
                          className="text-danger-600 hover:text-danger-800"
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ──────────────────── FORMULARIO COSTE ────────────────────

function CostForm({
  groupId,
  onSaved,
  onCancel,
}: {
  groupId: string;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    setPending(true);
    setError(null);
    try {
      const importeEur = Number(form.get('importeEur') ?? 0);
      const dto: CreateCostInput = {
        tipo: (form.get('tipo')?.toString() ?? 'DIRECTO') as CreateCostInput['tipo'],
        concepto: form.get('concepto')?.toString().trim() ?? '',
        amountCents: Math.round(importeEur * 100),
        notas: form.get('notas')?.toString() || undefined,
      };
      await fundaeGroupsApi.addCost(groupId, dto);
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos añadir el coste.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border-soft p-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="tipo" className="text-xs">
            Tipo
          </Label>
          <select
            id="tipo"
            name="tipo"
            defaultValue="DIRECTO"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            {(['DIRECTO', 'INDIRECTO', 'ORGANIZACION'] as const).map((t) => (
              <option key={t} value={t}>
                {TIPO_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="concepto" className="text-xs">
            Concepto <span className="text-danger-700">*</span>
          </Label>
          <Input id="concepto" name="concepto" required maxLength={200} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="importeEur" className="text-xs">
            Importe (€) <span className="text-danger-700">*</span>
          </Label>
          <Input
            id="importeEur"
            name="importeEur"
            type="number"
            step="0.01"
            min={0}
            required
            className="h-8 text-xs"
          />
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-2 text-xs text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Añadiendo…' : 'Añadir'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
