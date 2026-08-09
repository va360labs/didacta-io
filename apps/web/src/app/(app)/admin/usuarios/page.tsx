'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { UserChip } from '@/components/user-chip';
import {
  adminUsersApi,
  ASSIGNABLE_ROLES,
  type AssignableRole,
  type UserListItem,
  type UserStatus,
} from '@/lib/admin-users';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import { paymentTiersApi, type PaymentTier, type UserTier } from '@/lib/payment-connections';
import { authStorage } from '@/lib/auth-storage';

/// Tamaño de página por defecto. Coincide con el `limit` default del API.
/// Si cambia, ajustar también en backend (admin-users.controller.ts).
const PAGE_SIZE = 100;

const STATUS_VARIANT: Record<UserStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  ACTIVE: 'success',
  PENDING: 'warning',
  SUSPENDED: 'danger',
  DEACTIVATED: 'muted',
};

export default function UsuariosPage() {
  const t = useTranslations('adminUsuarios');
  const tErrors = useTranslations('errors');
  const [users, setUsers] = useState<UserListItem[] | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | UserStatus>('');
  const [roleFilter, setRoleFilter] = useState<'' | AssignableRole>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  // Tiers (mod.payment-connections). Si el módulo no está / no hay permiso, la
  // columna se oculta (tiersEnabled=false) y /admin/usuarios sigue funcionando.
  const [tiersEnabled, setTiersEnabled] = useState(false);
  const [tierCatalog, setTierCatalog] = useState<PaymentTier[]>([]);
  const [tierByUser, setTierByUser] = useState<Record<string, UserTier>>({});

  async function reload(targetPage: number = page) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      setError(null);
      const res = await adminUsersApi.list(token, {
        search: search.trim() || undefined,
        status: statusFilter || undefined,
        role: roleFilter || undefined,
        externalSource: sourceFilter || undefined,
        page: targetPage,
        limit: PAGE_SIZE,
      });
      setUsers(res.items);
      setTotal(res.total);
      setHasMore(res.hasMore);
      setPage(res.page);
      void loadTiers(res.items);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  async function loadTiers(items: UserListItem[]) {
    const token = authStorage.getAccessToken();
    if (!token || items.length === 0) return;
    try {
      const [catRes, utRes] = await Promise.all([
        paymentTiersApi.listCatalog(token),
        paymentTiersApi.getUserTiers(
          token,
          items.map((u) => u.id),
        ),
      ]);
      setTierCatalog(catRes.tiers);
      const map: Record<string, UserTier> = {};
      for (const ut of utRes.tiers) map[ut.userId] = ut;
      setTierByUser(map);
      setTiersEnabled(true);
    } catch {
      // Módulo de pagos desactivado o sin permiso (tenant_admin) → sin columna.
      setTiersEnabled(false);
    }
  }

  async function assignTier(userId: string, tierId: string | null) {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const { tier } = await paymentTiersApi.assignUserTier(token, userId, tierId);
      setTierByUser((prev) => ({ ...prev, [userId]: tier }));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }

  /// Aplicar filtros = volver siempre a página 1, si no el operador puede
  /// quedar "atascado" en una página fuera de rango después de filtrar.
  function applyFilters() {
    void reload(1);
  }

  useEffect(() => {
    void reload(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = users && users.length > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const rangeEnd = users ? (page - 1) * PAGE_SIZE + users.length : 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('list.title')}</h1>
          <p className="mt-1 text-text-muted">{t('list.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="secondary">
            <Link href="/admin/usuarios/importar">{t('list.importCsv')}</Link>
          </Button>
          <Button asChild>
            <Link href="/admin/usuarios/invitar">{t('list.invitePerson')}</Link>
          </Button>
        </div>
      </header>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="flex-1 min-w-[240px]">
            <label className="text-xs font-semibold text-text-muted" htmlFor="search">
              {t('list.searchLabel')}
            </label>
            <Input
              id="search"
              type="search"
              placeholder={t('list.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilters();
              }}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="status">
              {t('list.statusLabel')}
            </label>
            <Select
              id="status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as UserStatus)}
              className="mt-1 min-w-[160px]"
            >
              <option value="">{t('list.filterAll')}</option>
              <option value="ACTIVE">{t('list.filterActive')}</option>
              <option value="PENDING">{t('list.filterPending')}</option>
              <option value="SUSPENDED">{t('list.filterSuspended')}</option>
              <option value="DEACTIVATED">{t('list.filterDeactivated')}</option>
            </Select>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="role">
              {t('list.roleLabel')}
            </label>
            <Select
              id="role"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as AssignableRole)}
              className="mt-1 min-w-[180px]"
            >
              <option value="">{t('list.filterAll')}</option>
              {ASSIGNABLE_ROLES.map((k) => (
                <option key={k} value={k}>
                  {t(`roles.${k}`)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-muted" htmlFor="source">
              {t('list.sourceLabel')}
            </label>
            <Select
              id="source"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="mt-1 min-w-40"
            >
              <option value="">{t('list.filterAll')}</option>
              <option value="learndash">LearnDash</option>
            </Select>
          </div>
          <Button variant="secondary" onClick={applyFilters}>
            {t('list.apply')}
          </Button>
        </CardContent>
      </Card>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : users === null ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : users.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-xl font-semibold">{t('list.emptyTitle')}</h3>
            <p className="max-w-md text-text-muted">{t('list.emptyBody')}</p>
            <div className="flex items-center gap-2">
              <Button asChild variant="secondary">
                <Link href="/admin/usuarios/importar">{t('list.importCsv')}</Link>
              </Button>
              <Button asChild>
                <Link href="/admin/usuarios/invitar">{t('list.invitePerson')}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {total === 0
                ? t('list.countZero')
                : t('list.countRange', { start: rangeStart, end: rangeEnd, total })}
            </CardTitle>
            <CardDescription>{t('list.tableHint')}</CardDescription>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-y border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-6 py-3 font-semibold">{t('list.colPerson')}</th>
                  <th className="px-3 py-3 font-semibold">{t('list.colRoles')}</th>
                  <th className="px-3 py-3 font-semibold">{t('list.colStatus')}</th>
                  {tiersEnabled ? (
                    <th className="px-3 py-3 font-semibold">{t('list.colTier')}</th>
                  ) : null}
                  <th className="px-3 py-3 font-semibold">{t('list.colSource')}</th>
                  <th className="px-3 py-3 font-semibold">{t('list.colMfa')}</th>
                  <th className="px-6 py-3 font-semibold text-right">{t('list.colLastLogin')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-border last:border-0 hover:bg-surface-2"
                  >
                    <td className="px-6 py-3">
                      <UserChip
                        userId={u.id}
                        name={u.name}
                        email={u.email}
                        size={36}
                        nameClassName="block truncate font-semibold text-text"
                        subtitle={u.name ? u.email : null}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.roles.length === 0 ? (
                          <span className="text-xs italic text-text-subtle">
                            {t('list.noRole')}
                          </span>
                        ) : (
                          u.roles.map((r) => (
                            <Badge key={r} variant="muted">
                              {labelOr(t, `roles.${r}`, r)}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={STATUS_VARIANT[u.status]}>
                        {labelOr(t, `userStatus.${u.status}`, u.status)}
                      </Badge>
                    </td>
                    {tiersEnabled ? (
                      <td className="px-3 py-3">
                        <TierCell
                          tier={tierByUser[u.id]}
                          catalog={tierCatalog}
                          onAssign={(tierId) => void assignTier(u.id, tierId)}
                        />
                      </td>
                    ) : null}
                    <td className="px-3 py-3">
                      {u.externalSource ? (
                        <Badge variant="muted" title={u.externalId ?? undefined}>
                          {u.externalSource}
                        </Badge>
                      ) : (
                        <span className="text-xs text-text-subtle">{t('list.sourceNative')}</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {u.mfaEnabled ? (
                        <Badge variant="success" dot>
                          {t('list.mfaOn')}
                        </Badge>
                      ) : (
                        <Badge variant="muted">{t('list.mfaOff')}</Badge>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right text-xs text-text-muted tabular-nums">
                      {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* === Paginación === */}
          {totalPages > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2 px-6 py-3">
              <p className="text-xs text-text-muted tabular-nums">
                {t('list.pageOf', { page, total: totalPages })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void reload(page - 1)}
                  disabled={page <= 1}
                >
                  {t('list.prev')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void reload(page + 1)}
                  disabled={!hasMore}
                >
                  {t('list.next')}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}

/// Celda de tier: muestra el tier efectivo (manual o derivado de pagos, o
/// "Desconocido") y un desplegable para asignar el tier manual del catálogo
/// (incluido el "Free"). El derivado se sincroniza aparte desde Conexiones de pago.
function TierCell({
  tier,
  catalog,
  onAssign,
}: {
  tier: UserTier | undefined;
  catalog: PaymentTier[];
  onAssign: (tierId: string | null) => void;
}) {
  const t = useTranslations('adminUsuarios');
  const effective = tier?.effectiveLabel ?? null;
  const manualId = tier?.manualTierId ?? '';
  return (
    <div className="flex flex-col items-start gap-1">
      {effective ? (
        <Badge variant={tier?.source === 'derived' ? 'success' : 'muted'}>{effective}</Badge>
      ) : (
        <span className="text-xs italic text-text-subtle">{t('list.tierUnknown')}</span>
      )}
      <Select
        value={manualId}
        onChange={(e) => onAssign(e.target.value || null)}
        className="min-w-32 text-xs"
        aria-label={t('list.tierAssignAria')}
      >
        <option value="">{t('list.tierManualOption')}</option>
        {catalog.map((option) => (
          <option key={option.id} value={option.id}>
            {option.isFree ? t('list.tierFreeOption', { name: option.name }) : option.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
