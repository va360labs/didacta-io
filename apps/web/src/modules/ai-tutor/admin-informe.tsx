'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/select';
import { StatCard } from '@/components/stat-card';
import { ApiHttpError } from '@/lib/api-client';
import { aiTutorReviewApi, type MonthlyReportView, type ReportTopicView } from './client';

/**
 * Pestaña "Informe mensual": qué se preguntó ese mes, agrupado por tema.
 *
 * Las preguntas no se agrupan por texto literal —casi nunca se repite— sino por
 * significado, comparando los embeddings que ya se calcularon para responder.
 * Así "no me instala el nodo" y "error al instalar el nodo" caen en el mismo
 * tema, que es lo que hace el informe accionable: un tema con muchas preguntas
 * y ninguna cita al material es una clase que falta por grabar.
 */

/** Últimos 12 meses, del más reciente al más antiguo. */
function ultimosMeses(n: number): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const hoy = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({
      value,
      label: d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    });
  }
  return out;
}

export function AdminTutorInforme(): React.JSX.Element {
  const meses = useMemo(() => ultimosMeses(12), []);
  const [mes, setMes] = useState(meses[0]?.value ?? '');
  const [informe, setInforme] = useState<MonthlyReportView | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async (mesPedido: string) => {
    setCargando(true);
    setError(null);
    try {
      setInforme(await aiTutorReviewApi.monthlyReport(mesPedido || undefined));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos generar el informe.');
      setInforme(null);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar(mes);
  }, [cargar, mes]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Informe del mes</CardTitle>
          <CardDescription>
            Preguntas agrupadas por significado, de más a menos repetidas, con quién las hizo. Un
            tema muy preguntado y sin respaldo en el material es contenido que falta.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-text-muted">Mes</span>
              <NativeSelect
                value={mes}
                data-testid="informe-mes"
                onChange={(e) => setMes(e.target.value)}
              >
                {meses.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Button variant="secondary" disabled={cargando} onClick={() => void cargar(mes)}>
              {cargando ? 'Calculando…' : 'Actualizar'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {cargando && !informe ? <div className="skeleton h-40 w-full" /> : null}

      {informe ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Preguntas"
              value={informe.totalPreguntas}
              hint={`${informe.temas.length} temas distintos`}
              icon="message"
              tone="info"
            />
            <StatCard
              label="Alumnos que preguntaron"
              value={informe.alumnosActivos}
              icon="users"
              tone="info"
            />
            <StatCard
              label="Sin respaldo"
              value={informe.sinRespaldo}
              hint="el tutor no pudo citar material"
              icon="alert"
              tone={informe.sinRespaldo > 0 ? 'warn' : 'success'}
            />
            <StatCard
              label="Sin revisar"
              value={informe.pendientesDeRevision}
              hint={`${informe.corregidas} corregidas`}
              icon="bell"
              tone={informe.pendientesDeRevision > 0 ? 'warn' : 'success'}
            />
          </div>

          {informe.truncado ? (
            <div className="rounded-lg border border-warning-200 bg-[var(--didacta-warn-bg)] p-3 text-sm text-[var(--didacta-warn-fg)]">
              Este mes tuvo más preguntas de las que analizamos de una vez. El informe cubre las más
              antiguas del mes; el resto queda fuera.
            </div>
          ) : null}

          <Card data-testid="informe-temas-card">
            <CardHeader>
              <CardTitle>Temas más preguntados</CardTitle>
              <CardDescription>
                {informe.temas.length === 0
                  ? 'Todavía no hay preguntas este mes.'
                  : 'Ordenados por número de preguntas.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {informe.temas.slice(0, 30).map((t, i) => (
                <TemaFila key={`${t.pregunta}-${i}`} tema={t} />
              ))}
            </CardContent>
          </Card>

          {informe.topAlumnos.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Quién más pregunta</CardTitle>
                <CardDescription>
                  Útil para detectar a quien se está atascando y no lo dice en la comunidad.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {informe.topAlumnos.map((a) => (
                    <li key={a.id} className="flex items-center justify-between text-sm">
                      <span className="text-text">{a.name ?? 'Alumno'}</span>
                      <span className="text-text-subtle">
                        {a.veces} pregunta{a.veces !== 1 ? 's' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function TemaFila({ tema }: { tema: ReportTopicView }): React.JSX.Element {
  const [abierto, setAbierto] = useState(false);
  return (
    <div className="rounded-lg border border-border-soft p-3" data-testid="informe-tema">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text">{tema.pregunta}</p>
          <p className="mt-0.5 text-xs text-text-subtle">
            {tema.veces} pregunta{tema.veces !== 1 ? 's' : ''} · {tema.alumnos} alumno
            {tema.alumnos !== 1 ? 's' : ''} ·{' '}
            {tema.cursos.map((c) => c.title ?? 'curso').join(', ')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {tema.sinRespaldo > 0 ? (
            <Badge variant="warning">{tema.sinRespaldo} sin respaldo</Badge>
          ) : null}
          {tema.corregidas > 0 ? (
            <Badge variant="primary">{tema.corregidas} corregidas</Badge>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setAbierto(!abierto)}>
            {abierto ? 'Menos' : 'Detalle'}
          </Button>
        </div>
      </div>

      {abierto ? (
        <div className="mt-3 space-y-2 border-t border-border-soft pt-3 text-sm">
          <div>
            <p className="text-xs font-semibold text-text-muted">Quién lo preguntó</p>
            <ul className="mt-1 space-y-0.5">
              {tema.quienes.map((q) => (
                <li key={q.id} className="text-text">
                  {q.name ?? 'Alumno'}{' '}
                  <span className="text-text-subtle">
                    ({q.veces} {q.veces === 1 ? 'vez' : 'veces'})
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {tema.variantes.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-text-muted">Otras formas de preguntarlo</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-muted">
                {tema.variantes.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {tema.pendientesDeRevision > 0 ? (
            <p className="text-xs text-text-subtle">
              {tema.pendientesDeRevision} de estas respuestas siguen sin revisar.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
