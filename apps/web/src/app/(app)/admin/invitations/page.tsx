'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { accessGroupsApi, type AccessGroupListItem } from '@/lib/access-groups';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { authStorage } from '@/lib/auth-storage';
import {
  invitationsApi,
  type InvitationFilter,
  type InvitationRow,
  type InvitationsSummary,
} from '@/lib/invitations';

/**
 * Seguimiento de las invitaciones al aula.
 *
 * Responde a la pregunta que importa durante una migración: de todos los que
 * hemos avisado, ¿cuántos acaban entrando? Y permite ir mandando la invitación
 * por lotes, que es como se evita que el dominio acabe marcado como spam.
 */
const TAMANOS = [5, 25, 50, 100, 150];
/** Filas por página del listado. */
const PAGINA = 100;

export default function AdminInvitacionesPage() {
  const t = useTranslations('adminUsuarios');
  const tErrors = useTranslations('errors');
  const [summary, setSummary] = useState<InvitationsSummary | null>(null);
  const [filtro, setFiltro] = useState<InvitationFilter>('invitados');
  const [items, setItems] = useState<InvitationRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tamanoLote, setTamanoLote] = useState(25);
  const [arrancando, setArrancando] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [groupId, setGroupId] = useState('');
  // null = catálogo no disponible (módulo desactivado) → el selector no se pinta.
  const [groups, setGroups] = useState<AccessGroupListItem[] | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setBusqueda(search.trim()), 350);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let aborted = false;
    const token = authStorage.getAccessToken();
    if (!token) return;
    accessGroupsApi
      .list(token)
      .then((r) => {
        if (!aborted && r.groups.length > 0) setGroups(r.groups);
      })
      .catch(() => undefined);
    return () => {
      aborted = true;
    };
  }, []);

  const cargar = useCallback(async () => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const [s, page] = await Promise.all([
        invitationsApi.summary(token),
        invitationsApi.list(token, { filtro, search: busqueda || undefined, limit: PAGINA }),
      ]);
      setSummary(s);
      setItems(page.items);
      setTotal(page.total);
      setHayMas(page.hasMore);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    }
  }, [filtro, busqueda, tErrors]);

  /**
   * Trae la siguiente página y la añade. Sin esto, el panel enseñaba solo los
   * primeros 100 de cada filtro y el resto era invisible: con 467 invitados,
   * 367 personas parecían no existir.
   */
  const cargarMas = useCallback(async () => {
    const token = authStorage.getAccessToken();
    if (!token || !items) return;
    setCargandoMas(true);
    try {
      const page = await invitationsApi.list(token, {
        filtro,
        search: busqueda || undefined,
        limit: PAGINA,
        page: Math.floor(items.length / PAGINA) + 1,
      });
      setItems((previos) => [...(previos ?? []), ...page.items]);
      setHayMas(page.hasMore);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setCargandoMas(false);
    }
  }, [filtro, busqueda, items, tErrors]);

  /**
   * Mientras hay un lote en vuelo, refrescamos cada 3 s para que los
   * contadores avancen solos. El envío tarda ~1 s por correo y vive en el
   * servidor: cerrar la pestaña no lo detiene.
   */
  const envio = summary?.envio ?? null;
  useEffect(() => {
    if (!envio?.enCurso) return;
    const id = window.setInterval(() => void cargar(), 3000);
    return () => window.clearInterval(id);
  }, [envio?.enCurso, cargar]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function enviarLote() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setArrancando(true);
    setError(null);
    try {
      const r = await invitationsApi.sendBatch(token, {
        size: tamanoLote,
        accessGroupId: groupId || undefined,
      });
      if (r.yaEnCurso) {
        setError(t('invitations.alreadyRunning'));
      }
      await cargar();
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setArrancando(false);
    }
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-text">
          {t('invitations.title')}
        </h1>
        <p className="mt-2 max-w-3xl text-text-muted">{t('invitations.subtitle')}</p>
      </header>

      {error ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-danger-700">{error}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metrica valor={summary?.invitados} etiqueta={t('invitations.metricSent')} />
        <Metrica
          valor={summary?.activadosTrasInvitacion}
          etiqueta={t('invitations.metricEntered')}
          detalle={
            summary?.tasaConversion !== null && summary?.tasaConversion !== undefined
              ? t('invitations.conversionDetail', { rate: summary.tasaConversion })
              : undefined
          }
        />
        <Metrica valor={summary?.sinInvitar} etiqueta={t('invitations.metricPending')} />
        <Metrica
          valor={summary?.pendientesSinAcceso}
          etiqueta={t('invitations.metricNoAccess')}
          detalle={t('invitations.noAccessDetail')}
          alerta={(summary?.pendientesSinAcceso ?? 0) > 0}
        />
      </div>

      {/* Envío por lotes */}
      <Card>
        <CardHeader>
          <CardTitle>{t('invitations.batchTitle')}</CardTitle>
          <CardDescription>
            {t.rich('invitations.batchDescription', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {TAMANOS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setTamanoLote(n)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  tamanoLote === n
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-border text-text-muted hover:border-border-strong hover:text-text'
                }`}
              >
                {n}
              </button>
            ))}
            <Button
              type="button"
              onClick={enviarLote}
              disabled={arrancando || envio?.enCurso || (summary?.sinInvitar ?? 0) === 0}
              className="ml-auto"
            >
              {envio?.enCurso
                ? t('invitations.sending')
                : arrancando
                  ? t('invitations.starting')
                  : t('invitations.sendTo', { count: tamanoLote })}
            </Button>
          </div>

          {groups ? (
            <div className="space-y-2">
              <Label htmlFor="batchAccessGroup">{t('invitations.groupLabel')}</Label>
              <Select
                id="batchAccessGroup"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                disabled={arrancando || envio?.enCurso}
                data-testid="batch-invite-group-select"
              >
                <option value="">{t('invitations.noGroup')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-text-subtle">{t('invitations.groupHint')}</p>
            </div>
          ) : null}

          {(summary?.sinInvitar ?? 0) === 0 && summary ? (
            <p className="text-sm text-text-muted">{t('invitations.nobodyLeft')}</p>
          ) : null}

          {envio ? (
            <div className="rounded-lg border border-border bg-bg-subtle p-4 text-sm">
              <p className="font-semibold text-text">
                {envio.enCurso
                  ? t('invitations.progressRunning', { sent: envio.enviados, total: envio.total })
                  : t('invitations.progressDone', { sent: envio.enviados })}
                {envio.fallidos.length > 0
                  ? ` · ${t('invitations.failedSuffix', { count: envio.fallidos.length })}`
                  : ''}
              </p>
              {envio.enCurso ? (
                <>
                  <div
                    className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border"
                    role="progressbar"
                    aria-valuenow={envio.enviados}
                    aria-valuemin={0}
                    aria-valuemax={envio.total}
                  >
                    <div
                      className="h-full bg-brand-500 transition-all"
                      style={{
                        width: `${envio.total > 0 ? (envio.enviados / envio.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <p className="mt-2 text-text-muted">{t('invitations.progressHint')}</p>
                </>
              ) : (
                <p className="mt-1 text-text-muted">
                  {t('invitations.remaining', { count: summary?.sinInvitar ?? 0 })}
                </p>
              )}
              {envio.fallidos.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {envio.fallidos.slice(0, 10).map((f) => (
                    <li key={f.email} className="text-danger-700">
                      {f.email} — {f.error}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Listado */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-2">
          <Filtro actual={filtro} valor="invitados" onSelect={setFiltro}>
            {t('invitations.filterInvited')}
          </Filtro>
          <Filtro actual={filtro} valor="activados" onSelect={setFiltro}>
            {t('invitations.filterEntered')}
          </Filtro>
          <Filtro actual={filtro} valor="sin-enviar" onSelect={setFiltro}>
            {t('invitations.filterNotSent')}
          </Filtro>
          <Filtro actual={filtro} valor="sin-acceso" onSelect={setFiltro}>
            {t('invitations.filterNoAccess')}
          </Filtro>
        </div>
        <div className="flex-1">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('invitations.searchPlaceholder')}
            aria-label={t('invitations.searchAria')}
          />
        </div>
      </div>

      <Card className="p-0">
        <CardContent className="p-0">
          {items === null ? (
            <div className="space-y-2 p-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton h-10 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="p-8 text-center text-sm text-text-muted">{t('invitations.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-5 py-3 font-semibold">{t('invitations.colStudent')}</th>
                    <th className="px-5 py-3 font-semibold">{t('invitations.colStatus')}</th>
                    <th className="px-5 py-3 font-semibold">{t('invitations.colAccess')}</th>
                    <th className="px-5 py-3 font-semibold">{t('invitations.colInvited')}</th>
                    <th className="px-5 py-3 font-semibold">{t('invitations.colLastLogin')}</th>
                    <th className="px-5 py-3 text-right font-semibold">
                      {t('invitations.colSends')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((u) => (
                    <tr key={u.id} className="border-b border-border last:border-none">
                      <td className="px-5 py-3">
                        <div className="font-medium text-text">{u.name || '—'}</div>
                        <div className="text-xs text-text-muted">{u.email}</div>
                      </td>
                      <td className="px-5 py-3">
                        {u.entrado ? (
                          <span className="rounded-full bg-success-50 px-2 py-0.5 text-xs font-semibold text-success-700">
                            {t('invitations.entered')}
                          </span>
                        ) : (
                          <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-xs font-semibold text-text-muted">
                            {t('invitations.pending')}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {u.grupos.length === 0 ? (
                          <span className="rounded-full bg-danger-50 px-2 py-0.5 text-xs font-semibold text-danger-700">
                            {t('invitations.noCourses')}
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {u.grupos.slice(0, 3).map((g) => (
                              <span
                                key={g}
                                className="rounded-full bg-bg-subtle px-2 py-0.5 text-xs text-text-muted"
                              >
                                {g}
                              </span>
                            ))}
                            {u.grupos.length > 3 ? (
                              <span
                                className="rounded-full bg-bg-subtle px-2 py-0.5 text-xs text-text-muted"
                                title={u.grupos.join(', ')}
                              >
                                +{u.grupos.length - 3}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-text-muted">{fecha(u.invitedAt)}</td>
                      <td className="px-5 py-3 text-text-muted">{fecha(u.lastLoginAt)}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-text-muted">
                        {u.envios}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {total > items.length ? (
                <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
                  <p className="text-xs text-text-muted">
                    {t('invitations.showing', { shown: items.length, total })}
                  </p>
                  {hayMas ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => void cargarMas()}
                      disabled={cargandoMas}
                    >
                      {cargandoMas ? t('invitations.loadingMore') : t('invitations.loadMore')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function Metrica({
  valor,
  etiqueta,
  detalle,
  alerta = false,
}: {
  valor: number | undefined;
  etiqueta: string;
  detalle?: string;
  alerta?: boolean;
}) {
  return (
    <Card className={alerta ? 'border-danger-200' : undefined}>
      <CardContent className="p-5">
        <div
          className={`font-display text-2xl font-bold tracking-tight ${alerta ? 'text-danger-700' : 'text-text'}`}
        >
          {valor === undefined ? <span className="skeleton inline-block h-7 w-14" /> : valor}
        </div>
        <div className="mt-1 text-sm text-text-muted">{etiqueta}</div>
        {detalle ? <div className="mt-0.5 text-xs text-text-muted">{detalle}</div> : null}
      </CardContent>
    </Card>
  );
}

function Filtro({
  actual,
  valor,
  onSelect,
  children,
}: {
  actual: InvitationFilter;
  valor: InvitationFilter;
  onSelect: (v: InvitationFilter) => void;
  children: React.ReactNode;
}) {
  const activo = actual === valor;
  return (
    <button
      type="button"
      onClick={() => onSelect(valor)}
      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
        activo
          ? 'border-brand-500 bg-brand-50 text-brand-700'
          : 'border-border text-text-muted hover:border-border-strong hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}

function fecha(iso: string | null): string {
  if (!iso) return '—';
  return formatDate(iso, { day: '2-digit', month: 'short', year: 'numeric' });
}
