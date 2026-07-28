'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  invitationsApi,
  type BatchResult,
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

export default function AdminInvitacionesPage() {
  const [summary, setSummary] = useState<InvitationsSummary | null>(null);
  const [filtro, setFiltro] = useState<InvitationFilter>('invitados');
  const [items, setItems] = useState<InvitationRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tamanoLote, setTamanoLote] = useState(25);
  const [enviando, setEnviando] = useState(false);
  const [ultimoLote, setUltimoLote] = useState<BatchResult | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setBusqueda(search.trim()), 350);
    return () => window.clearTimeout(t);
  }, [search]);

  const cargar = useCallback(async () => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    try {
      const [s, page] = await Promise.all([
        invitationsApi.summary(token),
        invitationsApi.list(token, { filtro, search: busqueda || undefined, limit: 100 }),
      ]);
      setSummary(s);
      setItems(page.items);
      setTotal(page.total);
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? e.message : 'No pudimos cargar el estado de las invitaciones.',
      );
    }
  }, [filtro, busqueda]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function enviarLote() {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setEnviando(true);
    setError(null);
    setUltimoLote(null);
    try {
      const r = await invitationsApi.sendBatch(token, { size: tamanoLote });
      setUltimoLote(r);
      await cargar();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo enviar el lote.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-text">Invitaciones</h1>
        <p className="mt-2 max-w-3xl text-text-muted">
          Quién ha recibido la invitación al aula, quién ha acabado entrando y a quién le falta.
        </p>
      </header>

      {error ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-danger-700">{error}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metrica valor={summary?.invitados} etiqueta="Invitaciones enviadas" />
        <Metrica
          valor={summary?.activadosTrasInvitacion}
          etiqueta="Ya han entrado"
          detalle={
            summary?.tasaConversion !== null && summary?.tasaConversion !== undefined
              ? `${summary.tasaConversion}% de los invitados`
              : undefined
          }
        />
        <Metrica valor={summary?.sinInvitar} etiqueta="Sin invitar todavía" />
        <Metrica valor={summary?.pendientes} etiqueta="Pendientes de activar" />
      </div>

      {/* Envío por lotes */}
      <Card>
        <CardHeader>
          <CardTitle>Enviar el siguiente lote</CardTitle>
          <CardDescription>
            Se envía solo a quien <strong>aún no ha recibido</strong> la invitación, así que puedes
            repetirlo sin miedo a escribir dos veces a nadie. Se manda de uno en uno y con una pausa
            entre correos: de golpe, el dominio acaba marcado como spam y eso arrastraría también a
            los correos de contraseña y certificados.
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
              disabled={enviando || (summary?.sinInvitar ?? 0) === 0}
              className="ml-auto"
            >
              {enviando ? 'Enviando…' : `Enviar a ${tamanoLote}`}
            </Button>
          </div>

          {(summary?.sinInvitar ?? 0) === 0 && summary ? (
            <p className="text-sm text-text-muted">
              No queda nadie por invitar. Cuando se creen cuentas nuevas aparecerán aquí.
            </p>
          ) : null}

          {ultimoLote ? (
            <div className="rounded-lg border border-border bg-bg-subtle p-4 text-sm">
              <p className="font-semibold text-text">
                Enviadas {ultimoLote.enviados} invitaciones
                {ultimoLote.fallidos.length > 0 ? ` · ${ultimoLote.fallidos.length} fallaron` : ''}
              </p>
              <p className="mt-1 text-text-muted">
                Quedan {ultimoLote.pendientesRestantes} por invitar.
              </p>
              {ultimoLote.fallidos.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {ultimoLote.fallidos.slice(0, 10).map((f) => (
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
            Invitados
          </Filtro>
          <Filtro actual={filtro} valor="activados" onSelect={setFiltro}>
            Ya entraron
          </Filtro>
          <Filtro actual={filtro} valor="sin-enviar" onSelect={setFiltro}>
            Sin invitar
          </Filtro>
        </div>
        <div className="flex-1">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por email o nombre…"
            aria-label="Buscar en las invitaciones"
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
            <p className="p-8 text-center text-sm text-text-muted">
              No hay nadie en esta lista todavía.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-5 py-3 font-semibold">Alumno</th>
                    <th className="px-5 py-3 font-semibold">Estado</th>
                    <th className="px-5 py-3 font-semibold">Invitado</th>
                    <th className="px-5 py-3 font-semibold">Último acceso</th>
                    <th className="px-5 py-3 text-right font-semibold">Envíos</th>
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
                        {u.status === 'ACTIVE' ? (
                          <span className="rounded-full bg-success-50 px-2 py-0.5 text-xs font-semibold text-success-700">
                            Ya entró
                          </span>
                        ) : (
                          <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-xs font-semibold text-text-muted">
                            Pendiente
                          </span>
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
                <p className="px-5 py-3 text-xs text-text-muted">
                  Mostrando {items.length} de {total}. Afina con la búsqueda para ver el resto.
                </p>
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
}: {
  valor: number | undefined;
  etiqueta: string;
  detalle?: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="font-display text-2xl font-bold tracking-tight text-text">
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
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
