'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate, formatDateTime } from '@/lib/i18n/format';
import {
  fundaeInspectionApi,
  type InspectionParticipant,
  type InspectionView,
  type InspectorGroupRef,
} from '@/modules/fundae';
import { queryParam } from '@/lib/legacy-routes';

/**
 * Expediente de seguimiento de una acción bonificada, tal y como lo mira la
 * INSPECCIÓN (LMS-123).
 *
 * Esta pantalla NO está en el panel de administración a propósito: quien entra
 * con las claves comunicadas a Fundae no es admin del tenant, no ve el panel y
 * no debe verlo. Es de solo lectura y está acotada al grupo concedido — la
 * propia API vuelve a comprobar la concesión contra la base en cada llamada,
 * así que un enlace guardado deja de abrir en cuanto el acceso se retira o
 * caduca.
 *
 * Un `tenant_admin` también entra, con `?group=<id>`, desde el detalle del
 * grupo: quien firma la bonificación necesita ver el expediente tal y como lo
 * verá la inspección ANTES de comunicar las claves.
 *
 * El recorrido del CONTENIDO no está aquí: el inspector abre el curso desde
 * "Mis cursos" como cualquier alumno, gracias a la matrícula `INSPECTION` que
 * se crea al concederle el acceso.
 */
export default function SeguimientoFundaePage() {
  const t = useTranslations('modFundae');
  const tErrors = useTranslations('errors');
  const params = useSearchParams();
  const requestedGroupId = queryParam(params, 'group');

  const [groups, setGroups] = useState<InspectorGroupRef[] | null>(null);
  const [selected, setSelected] = useState<string | null>(requestedGroupId);
  const [view, setView] = useState<InspectionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    void (async () => {
      try {
        const list = await fundaeInspectionApi.myGroups();
        if (aborted) return;
        setGroups(list);
        // Con un solo grupo concedido no tiene sentido pedir que lo elija.
        setSelected((prev) => prev ?? (list.length === 1 ? list[0].groupId : null));
      } catch (e) {
        if (!aborted) setError(apiErrorMessage(e, tErrors));
      }
    })();
    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) {
      setView(null);
      return;
    }
    let aborted = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await fundaeInspectionApi.get(selected);
        if (!aborted) setView(data);
      } catch (e) {
        if (!aborted) {
          setView(null);
          setError(apiErrorMessage(e, tErrors));
        }
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const showPicker = !selected && groups !== null;

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('seguimiento.title')}</h1>
        <p className="text-sm text-text-muted">{t('seguimiento.description')}</p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showPicker ? <GroupPicker groups={groups} onPick={setSelected} /> : null}

      {selected && groups !== null && groups.length > 1 ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(null)}>
          <Icon name="arrow-left" size={13} />
          {t('seguimiento.backToGroups')}
        </Button>
      ) : null}

      {loading ? <p className="text-sm text-text-muted">{t('seguimiento.loading')}</p> : null}

      {view ? <Expediente view={view} /> : null}
    </section>
  );
}

function GroupPicker({
  groups,
  onPick,
}: {
  groups: InspectorGroupRef[];
  onPick: (id: string) => void;
}) {
  const t = useTranslations('modFundae');

  if (groups.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('seguimiento.emptyTitle')}</CardTitle>
          <CardDescription>{t('seguimiento.emptyDescription')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {groups.map((g) => (
        <Card key={g.groupId}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {t('seguimiento.groupNumber', { numero: String(g.numeroGrupo) })}
            </CardTitle>
            <CardDescription className="font-mono text-xs">{g.codigoAccion}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" size="sm" onClick={() => onPick(g.groupId)}>
              <Icon name="eye" size={13} />
              {t('seguimiento.openGroup')}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Expediente({ view }: { view: InspectionView }) {
  const t = useTranslations('modFundae');
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {view.denominacion}
          <Badge variant="muted" className="font-mono">
            {view.codigoAccion}
          </Badge>
          <Badge variant="info">
            {t('seguimiento.groupNumber', { numero: String(view.numeroGrupo) })}
          </Badge>
        </CardTitle>
        <CardDescription>
          {formatDate(view.fechaInicioPrevista)} → {formatDate(view.fechaFinPrevista)} ·{' '}
          {t('seguimiento.hoursOfAction', { hours: view.horasFormacion })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-text-muted">{t('seguimiento.readOnlyNote')}</p>

        <Link
          href="/courses"
          className="inline-flex items-center gap-1 text-sm text-brand-700 underline"
        >
          <Icon name="book" size={13} />
          {t('seguimiento.openCourse')}
        </Link>

        {view.participants.length === 0 ? (
          <p className="text-sm text-text-muted">{t('seguimiento.noParticipants')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-subtle">
                  <th className="pb-1 pr-2 font-medium">{t('seguimiento.colParticipante')}</th>
                  <th className="pb-1 pr-2 font-medium">{t('seguimiento.colNif')}</th>
                  <th className="pb-1 pr-2 text-right font-medium">{t('seguimiento.colHoras')}</th>
                  <th className="pb-1 pr-2 text-right font-medium">
                    {t('seguimiento.colActividades')}
                  </th>
                  <th className="pb-1 pr-2 text-right font-medium">
                    {t('seguimiento.colLecciones')}
                  </th>
                  <th className="pb-1 pr-2 font-medium">{t('seguimiento.colAccesos')}</th>
                  <th className="pb-1 pr-2 text-right font-medium">
                    {t('seguimiento.colResultado')}
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.participants.map((p) => (
                  <ParticipantRows
                    key={p.userId}
                    p={p}
                    expanded={expanded === p.userId}
                    onToggle={() => setExpanded((prev) => (prev === p.userId ? null : p.userId))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ParticipantRows({
  p,
  expanded,
  onToggle,
}: {
  p: InspectionParticipant;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('modFundae');
  const rowId = `itinerario-${p.userId}`;

  return (
    <>
      <tr className="border-t border-border-soft align-top">
        <td className="py-1 pr-2">
          <div className="font-medium">{p.nombre ?? '—'}</div>
          <div className="text-text-subtle">{p.email ?? '—'}</div>
        </td>
        <td className="py-1 pr-2 font-mono">{p.nifAlumno ?? '—'}</td>
        <td className="py-1 pr-2 text-right tabular-nums">
          <div className="font-semibold">
            {t('seguimiento.hoursShort', { hours: p.horasAsistidas })}
          </div>
          <div className="text-text-subtle">{p.pctHoras}%</div>
          {p.horasSinVerificar > 0 ? (
            // Horas que solo se sostienen en que el alumno marcó la lección
            // como vista. Se enseñan aparte porque no son defendibles igual.
            <div className="text-warning-700">
              {t('seguimiento.hoursUnverified', { hours: p.horasSinVerificar })}
            </div>
          ) : null}
        </td>
        <td className="py-1 pr-2 text-right tabular-nums">
          {p.actividadesSuperadas}/{p.actividadesTotales}
          <div className="text-text-subtle">{p.pctActividades}%</div>
        </td>
        <td className="py-1 pr-2 text-right tabular-nums">
          {p.leccionesCompletadas}/{p.leccionesTotales}
          <div className="text-text-subtle">
            {t('seguimiento.verifiedShort', { count: p.leccionesVerificadas })}
          </div>
        </td>
        <td className="py-1 pr-2">
          <div>{p.primerAccesoAt ? formatDateTime(p.primerAccesoAt) : '—'}</div>
          <div className="text-text-subtle">
            {p.ultimoAccesoAt ? formatDateTime(p.ultimoAccesoAt) : '—'}
          </div>
        </td>
        <td className="py-1 pr-2 text-right">
          {p.resultado ? (
            <Badge
              variant={
                p.resultado === 'APTO' ? 'success' : p.resultado === 'NO_APTO' ? 'warning' : 'muted'
              }
            >
              {p.resultado}
            </Badge>
          ) : (
            '—'
          )}
        </td>
        <td className="py-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={rowId}
            className="text-brand-700 underline"
          >
            {expanded ? t('seguimiento.hideItinerary') : t('seguimiento.showItinerary')}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr id={rowId} className="border-t border-border-soft bg-surface-soft">
          <td colSpan={8} className="p-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-subtle">
                  <th className="pb-1 pr-2 font-medium">#</th>
                  <th className="pb-1 pr-2 font-medium">{t('seguimiento.colModulo')}</th>
                  <th className="pb-1 pr-2 font-medium">{t('seguimiento.colLeccion')}</th>
                  <th className="pb-1 pr-2 text-right font-medium">{t('seguimiento.colTiempo')}</th>
                  <th className="pb-1 pr-2 font-medium">{t('seguimiento.colPrimerAcceso')}</th>
                  <th className="pb-1 pr-2 font-medium">{t('seguimiento.colUltimoAcceso')}</th>
                  <th className="pb-1 pr-2 font-medium">{t('seguimiento.colCompletada')}</th>
                </tr>
              </thead>
              <tbody>
                {p.itinerario.map((l) => (
                  <tr key={`${l.orden}-${l.leccion}`} className="border-t border-border-soft">
                    <td className="py-1 pr-2 tabular-nums">{l.orden}</td>
                    <td className="py-1 pr-2">{l.modulo}</td>
                    <td className="py-1 pr-2">
                      {l.leccion}
                      <span className="ml-1 text-text-subtle">({l.tipo})</span>
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {t('seguimiento.minutesShort', {
                        minutes: Math.round(l.segundosRegistrados / 60),
                      })}
                    </td>
                    <td className="py-1 pr-2">
                      {l.primerAccesoAt ? formatDateTime(l.primerAccesoAt) : '—'}
                    </td>
                    <td className="py-1 pr-2">
                      {l.ultimoAccesoAt ? formatDateTime(l.ultimoAccesoAt) : '—'}
                    </td>
                    <td className="py-1 pr-2">
                      {l.completada ? (
                        <Badge variant={l.verificada ? 'success' : 'warning'}>
                          {l.verificada
                            ? t('seguimiento.verified', { origen: l.origenCompletado ?? '—' })
                            : t('seguimiento.selfDeclared')}
                        </Badge>
                      ) : (
                        <Badge variant="muted">{t('seguimiento.notCompleted')}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      ) : null}
    </>
  );
}
