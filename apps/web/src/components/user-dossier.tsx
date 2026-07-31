'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/select';
import { RestrictionDialog } from '@/components/restriction-shield';
import {
  adminUsersApi,
  ASSIGNABLE_ROLES,
  ROLE_LABELS,
  type AssignableRole,
} from '@/lib/admin-users';
import { authStorage } from '@/lib/auth-storage';
import {
  dossierApi,
  ENTITLEMENT_LABELS,
  formatDate,
  formatDateTime,
  formatMembership,
  formatMoney,
  WOO_STATUS_LABELS,
  type UserDossier,
} from '@/lib/dossier';

/**
 * Expediente de un usuario, visible solo para admins dentro de `/u/[id]`.
 *
 * Va aquí y no en una página aparte a propósito: la regla del proyecto prohíbe
 * dos caminos al mismo destino, y ya existía el histórico de `/inicio` contra
 * `/comunidad`. Con esto, pulsar un nombre desde cualquier sección lleva
 * siempre al mismo sitio; lo que cambia es cuánto ve quien mira.
 */

const TABS = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'compras', label: 'Compras y suscripción' },
  { id: 'formacion', label: 'Formación' },
  { id: 'actividad', label: 'Actividad' },
  { id: 'mensajes', label: 'Mensajes' },
  { id: 'acceso', label: 'Acceso' },
  { id: 'sanciones', label: 'Sanciones' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Activo',
  PENDING: 'Pendiente',
  SUSPENDED: 'Suspendido',
  DEACTIVATED: 'Desactivado',
};

const SUB_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendiente',
  TRIALING: 'En prueba',
  ACTIVE: 'Activa',
  PAST_DUE: 'Impago',
  UNPAID: 'Sin pagar',
  CANCELED: 'Cancelada',
};

const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendiente',
  COMPLETED: 'Pagado',
  CANCELLED: 'Cancelado',
  FAILED: 'Fallido',
  REFUNDED: 'Devuelto',
};

export function UserDossierPanel({
  userId,
  initialTab,
}: {
  userId: string;
  initialTab?: string | null;
}) {
  const [data, setData] = useState<UserDossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(
    (TABS.find((t) => t.id === initialTab)?.id ?? 'resumen') as TabId,
  );
  const [moderating, setModerating] = useState(false);

  const load = () => {
    dossierApi
      .get(userId)
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'No se pudo cargar el expediente.'),
      );
  };

  useEffect(() => {
    let aborted = false;
    setData(null);
    setError(null);
    dossierApi
      .get(userId)
      .then((d) => {
        if (!aborted) setData(d);
      })
      .catch((err) => {
        if (!aborted) {
          setError(err instanceof Error ? err.message : 'No se pudo cargar el expediente.');
        }
      });
    return () => {
      aborted = true;
    };
  }, [userId]);

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-text-muted">{error}</CardContent>
      </Card>
    );
  }

  if (!data) return <div className="skeleton h-64 w-full" />;

  const activeRestrictions = data.restrictions.filter((r) => r.active);

  return (
    <section className="space-y-4" data-testid="user-dossier">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-text">Expediente</h2>
        <button
          type="button"
          onClick={() => setModerating(true)}
          className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-bg-subtle"
          data-testid="open-moderation"
        >
          Moderar
        </button>
      </div>

      {activeRestrictions.length > 0 ? (
        <Card>
          <CardContent className="border-l-4 border-l-red-500 p-4">
            <p className="text-sm font-semibold text-red-700 dark:text-red-400">
              Sancionado: {activeRestrictions.map((r) => r.scopeLabels.join(', ')).join(' · ')}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">
              {activeRestrictions[0]!.expiresAt
                ? `Hasta el ${formatDateTime(activeRestrictions[0]!.expiresAt)}`
                : 'Permanente'}{' '}
              · «{activeRestrictions[0]!.reason}»
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`dossier-tab-${t.id}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t.id
                ? 'border-brand-500 font-semibold text-brand-700'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'resumen' ? <ResumenTab d={data} /> : null}
      {tab === 'compras' ? <ComprasTab d={data} /> : null}
      {tab === 'formacion' ? <FormacionTab d={data} /> : null}
      {tab === 'actividad' ? <ActividadTab d={data} /> : null}
      {tab === 'mensajes' ? <MensajesTab d={data} /> : null}
      {tab === 'acceso' ? <AccesoTab d={data} onChanged={load} /> : null}
      {tab === 'sanciones' ? <SancionesTab d={data} /> : null}

      {moderating ? (
        <RestrictionDialog
          userId={userId}
          userName={data.identity.name ?? data.identity.email}
          onClose={() => {
            setModerating(false);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-[11px] uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-0.5 font-display text-lg font-semibold text-text">{value}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-text-muted">{children}</p>;
}

/**
 * Antigüedad real: se cuenta desde la primera compra, no desde el alta.
 *
 * Muchas cuentas se crearon en la importación masiva mucho después de que la
 * persona comprara: quien compró semanas antes de tener cuenta parecería
 * llevar tres días siendo clienta.
 */
function antiguedadDias(d: UserDossier): number {
  if (!d.commerce.customerSince) return d.identity.membershipDays;
  const desdeCompra = Math.floor(
    (Date.now() - new Date(d.commerce.customerSince).getTime()) / 86_400_000,
  );
  return Math.max(desdeCompra, d.identity.membershipDays);
}

function ResumenTab({ d }: { d: UserDossier }) {
  const sub = d.commerce.subscriptions.find(
    (s) => s.status === 'ACTIVE' || s.status === 'TRIALING',
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Antigüedad" value={formatMembership(antiguedadDias(d))} />
        <Stat
          label="Total pagado"
          value={formatMoney(d.commerce.totalPaidCents + d.commerce.totalPaidExternalCents)}
        />
        <Stat label="Cursos" value={d.learning.enrollments.length} />
        <Stat label="Último acceso" value={formatDate(d.identity.lastLoginAt)} />
        <Stat label="Publicaciones" value={d.activity.counts.posts} />
        <Stat label="Comentarios" value={d.activity.counts.comments} />
        <Stat label="Mensajes" value={d.activity.counts.messages} />
        <Stat label="Preguntas al tutor" value={d.activity.counts.aiQuestions} />
      </div>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <Row label="Email" value={d.identity.email} />
          <Row label="Estado" value={STATUS_LABEL[d.identity.status] ?? d.identity.status} />
          <Row label="Roles" value={d.identity.roles.join(', ') || '—'} />
          <Row label="Alta" value={formatDate(d.identity.createdAt)} />
          <Row
            label="Suscripción"
            value={
              sub
                ? `${sub.planName ?? 'Plan'} · ${SUB_STATUS_LABEL[sub.status] ?? sub.status}${
                    sub.currentPeriodEnd ? ` · vence ${formatDate(sub.currentPeriodEnd)}` : ''
                  }`
                : 'Sin suscripción activa'
            }
          />
          {d.gamification ? (
            <Row
              label="Puntos"
              value={`${d.gamification.lifetimePoints.toLocaleString('es-ES')}${
                d.gamification.levelKey ? ` · nivel ${d.gamification.levelKey}` : ''
              }`}
            />
          ) : null}
          {d.identity.externalSource ? (
            <Row label="Origen" value={d.identity.externalSource} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-border-soft pb-1.5 last:border-0">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text">{value}</span>
    </div>
  );
}

/** Pastilla del tipo de derecho: lo que decide si ese acceso caduca o no. */
function KindPill({ kind }: { kind: string }) {
  const variant =
    kind === 'LIFETIME'
      ? 'success'
      : kind === 'SUBSCRIPTION' || kind === 'TIMED'
        ? 'warning'
        : 'muted';
  return <Badge variant={variant}>{ENTITLEMENT_LABELS[kind] ?? kind}</Badge>;
}

/**
 * Compras hechas en la tienda externa. Es el histórico de verdad: las ventas
 * dentro de Didacta son un puñado y todo lo demás se compró en la tienda.
 */
function TiendaExterna({ d }: { d: UserDossier }) {
  const pedidos = d.commerce.externalOrders;
  if (pedidos.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-text">
        Compras en la tienda ({pedidos.length}) · {formatMoney(d.commerce.totalPaidExternalCents)}{' '}
        cobrado
        {d.commerce.customerSince ? (
          <span className="font-normal text-text-muted">
            {' '}
            · cliente desde {formatDate(d.commerce.customerSince)}
          </span>
        ) : null}
      </h3>
      <div className="space-y-2">
        {pedidos.map((o) => (
          <Card key={o.id}>
            <CardContent className="p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-text">
                    {o.products.join(' · ') || `Pedido ${o.externalId}`}
                  </p>
                  <p className="text-xs text-text-muted">
                    {formatDate(o.paidAt ?? o.placedAt)} · {o.provider} #{o.externalId} ·{' '}
                    {WOO_STATUS_LABELS[o.status] ?? o.status}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <KindPill kind={o.entitlementKind} />
                  <span className="font-semibold text-text">
                    {formatMoney(o.paid ? o.totalAmount : null, o.currency)}
                  </span>
                </div>
              </div>

              {/* Solo los accesos con vigencia caducan por su cuenta: la tienda
                  no avisa de estos, así que se marcan aquí. */}
              {o.accessEndsAt ? (
                <p
                  className={`mt-1.5 text-xs ${
                    o.daysToExpiry !== null && o.daysToExpiry < 0
                      ? 'font-semibold text-red-600 dark:text-red-400'
                      : 'text-text-muted'
                  }`}
                >
                  {o.daysToExpiry !== null && o.daysToExpiry < 0
                    ? `Acceso caducado el ${formatDate(o.accessEndsAt)}`
                    : `Acceso hasta el ${formatDate(o.accessEndsAt)}${
                        o.daysToExpiry !== null ? ` (quedan ${o.daysToExpiry} días)` : ''
                      }`}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ComprasTab({ d }: { d: UserDossier }) {
  return (
    <div className="space-y-4">
      <TiendaExterna d={d} />
      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">
          Suscripciones ({d.commerce.subscriptions.length})
        </h3>
        {d.commerce.subscriptions.length === 0 ? (
          <Empty>Sin suscripciones.</Empty>
        ) : (
          <div className="space-y-2">
            {d.commerce.subscriptions.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <p className="font-semibold text-text">{s.planName ?? 'Plan'}</p>
                    <p className="text-xs text-text-muted">
                      {formatMoney(s.unitAmount, s.currency)} / {s.interval}
                      {s.currentPeriodEnd ? ` · vence ${formatDate(s.currentPeriodEnd)}` : ''}
                      {s.daysToRenewal !== null && s.daysToRenewal >= 0
                        ? ` (en ${s.daysToRenewal} días)`
                        : ''}
                      {s.cancelAtPeriodEnd ? ' · no renueva' : ''}
                      {s.trialEndsAt ? ` · prueba hasta ${formatDate(s.trialEndsAt)}` : ''}
                    </p>
                  </div>
                  <Badge variant={s.status === 'ACTIVE' ? 'success' : 'muted'}>
                    {SUB_STATUS_LABEL[s.status] ?? s.status}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {d.commerce.externalSubscriptions.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">Suscripciones en otras pasarelas</h3>
          <div className="space-y-2">
            {d.commerce.externalSubscriptions.map((s, i) => (
              <Card key={`${s.provider}-${i}`}>
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <p className="font-semibold text-text">{s.productName ?? s.provider}</p>
                    <p className="text-xs text-text-muted">
                      {s.provider}
                      {s.currentPeriodEnd ? ` · vence ${formatDate(s.currentPeriodEnd)}` : ''}
                    </p>
                  </div>
                  <Badge variant={s.entitled ? 'success' : 'muted'}>{s.status}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">
          Compras ({d.commerce.orders.length}) · {formatMoney(d.commerce.totalPaidCents)} cobrado
        </h3>
        {d.commerce.orders.length === 0 ? (
          <Empty>Sin compras.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs uppercase text-text-muted">
                <tr>
                  <th className="py-2">Curso</th>
                  <th className="py-2">Importe</th>
                  <th className="py-2">Estado</th>
                  <th className="py-2">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {d.commerce.orders.map((o) => (
                  <tr key={o.id} className="border-t border-border-soft">
                    <td className="py-2">{o.courseTitle ?? '—'}</td>
                    <td className="py-2">{formatMoney(o.amountPaid, o.currency)}</td>
                    <td className="py-2">
                      <Badge variant={o.status === 'COMPLETED' ? 'success' : 'muted'}>
                        {ORDER_STATUS_LABEL[o.status] ?? o.status}
                      </Badge>
                    </td>
                    <td className="py-2 text-text-muted">
                      {formatDate(o.completedAt ?? o.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function FormacionTab({ d }: { d: UserDossier }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">
          Cursos ({d.learning.enrollments.length})
        </h3>
        {d.learning.enrollments.length === 0 ? (
          <Empty>Sin matrículas.</Empty>
        ) : (
          <div className="space-y-2">
            {d.learning.enrollments.map((e) => (
              <Card key={e.courseId}>
                <CardContent className="p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-text">{e.courseTitle ?? e.courseId}</p>
                    <span className="text-xs text-text-muted">
                      {e.progressPercent}% · desde {formatDate(e.enrolledAt)}
                      {e.completedAt ? ` · completado ${formatDate(e.completedAt)}` : ''}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-subtle">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${Math.min(100, Math.max(0, e.progressPercent))}%` }}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">
            Certificados ({d.learning.certificates.length})
          </h3>
          {d.learning.certificates.length === 0 ? (
            <Empty>Sin certificados.</Empty>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.learning.certificates.map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span className="font-mono text-xs">{c.number}</span>
                  <span className="text-text-muted">
                    {formatDate(c.issuedAt)}
                    {c.revokedAt ? ' · revocado' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">
            Asistencia a clases ({d.learning.liveAttendance.length})
          </h3>
          {d.learning.liveAttendance.length === 0 ? (
            <Empty>Sin asistencias registradas.</Empty>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.learning.liveAttendance.map((a) => (
                <li key={a.sessionId} className="flex justify-between gap-2">
                  <span className="text-text-muted">{formatDate(a.joinedAt)}</span>
                  <span>{a.present ? `${a.minutes ?? 0} min` : 'No asistió'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {d.learning.quizAttempts.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">
            Intentos de evaluación ({d.learning.quizAttempts.length})
          </h3>
          <ul className="space-y-1 text-sm">
            {d.learning.quizAttempts.map((a) => (
              <li key={a.id} className="flex justify-between gap-2">
                <span className="text-text-muted">{formatDate(a.submittedAt)}</span>
                <span>
                  {a.scorePercent !== null ? `${a.scorePercent}%` : '—'}
                  {a.passed === true ? ' · apto' : a.passed === false ? ' · no apto' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ActividadTab({ d }: { d: UserDossier }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Publicaciones" value={d.activity.counts.posts} />
        <Stat label="Comentarios" value={d.activity.counts.comments} />
        <Stat label="Reacciones" value={d.activity.counts.reactions} />
        <Stat label="Coment. lección" value={d.activity.counts.lessonComments} />
        <Stat label="Recursos" value={d.activity.counts.resources} />
        <Stat label="Preguntas IA" value={d.activity.counts.aiQuestions} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">Últimas publicaciones</h3>
        {d.activity.posts.length === 0 ? (
          <Empty>No ha publicado nada.</Empty>
        ) : (
          <div className="space-y-2">
            {d.activity.posts.map((p) => (
              <Card key={p.id}>
                <CardContent className="p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    {p.title ? <span className="font-semibold text-text">{p.title}</span> : null}
                    <span className="text-xs text-text-muted">{formatDateTime(p.createdAt)}</span>
                    {p.hiddenAt ? <Badge variant="warning">Oculto</Badge> : null}
                    {p.deletedAt ? <Badge variant="muted">Borrado</Badge> : null}
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-text-muted">{p.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">Últimos comentarios</h3>
        {d.activity.comments.length === 0 ? (
          <Empty>No ha comentado nada.</Empty>
        ) : (
          <div className="space-y-2">
            {d.activity.comments.map((c) => (
              <Card key={c.id}>
                <CardContent className="p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-text-muted">{formatDateTime(c.createdAt)}</span>
                    {c.hiddenAt ? <Badge variant="warning">Oculto</Badge> : null}
                    {c.deletedAt ? <Badge variant="muted">Borrado</Badge> : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-text-muted">{c.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MensajesTab({ d }: { d: UserDossier }) {
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 text-xs text-text-muted">
          Contiene comunicaciones privadas. Cada apertura de este expediente queda registrada en el
          log de auditoría con tu usuario y la fecha.
        </CardContent>
      </Card>

      <h3 className="text-sm font-semibold text-text">
        {d.messages.total.toLocaleString('es-ES')} mensajes · últimos {d.messages.recent.length}
      </h3>

      {d.messages.recent.length === 0 ? (
        <Empty>No ha enviado mensajes.</Empty>
      ) : (
        <div className="space-y-2">
          {d.messages.recent.map((m) => (
            <Card key={m.id}>
              <CardContent className="p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <Badge variant="muted">{m.conversationType}</Badge>
                  <span>{formatDateTime(m.createdAt)}</span>
                  {m.deletedAt ? <Badge variant="warning">Eliminado por el autor</Badge> : null}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-text">{m.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pestaña de acceso. Además de mostrar, ACTÚA: suspender, reactivar, reenviar
 * el email de contraseña y gestionar roles.
 *
 * Estas acciones venían de `/admin/usuarios/[id]`, que ahora redirige aquí.
 * Consolidar la ruta sin traerse las acciones habría sido perder funcionalidad,
 * no simplificar.
 */
function AccesoTab({ d, onChanged }: { d: UserDossier; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<AssignableRole>('alumno');

  const run = async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo completar la acción.');
    } finally {
      setBusy(null);
    }
  };

  const token = () => authStorage.getAccessToken() ?? '';
  const suspended = d.identity.status !== 'ACTIVE';
  const assignable = ASSIGNABLE_ROLES.filter((r) => !d.identity.roles.includes(r));

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            {suspended ? (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    'status',
                    () => adminUsersApi.setStatus(token(), d.identity.id, 'ACTIVE'),
                    'Acceso reactivado.',
                  )
                }
                data-testid="reactivate-user"
              >
                Reactivar acceso
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    'status',
                    () => adminUsersApi.setStatus(token(), d.identity.id, 'SUSPENDED'),
                    'Acceso suspendido y sesiones cerradas.',
                  )
                }
                data-testid="suspend-user"
              >
                Suspender acceso
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  'resend',
                  () => adminUsersApi.resendInvite(token(), d.identity.id),
                  'Email enviado.',
                )
              }
            >
              Reenviar email de contraseña
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Suspender corta el acceso entero. Para dejarle entrar y leer pero no publicar, usa
            «Moderar».
          </p>
          {msg ? <p className="text-sm text-green-700 dark:text-green-400">{msg}</p> : null}
          {err ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {err}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 text-sm">
          <Row label="Estado" value={STATUS_LABEL[d.identity.status] ?? d.identity.status} />
          <Row label="Email verificado" value={d.identity.emailVerified ? 'Sí' : 'No'} />
          <Row label="Doble factor" value={d.identity.mfaEnabled ? 'Activado' : 'No'} />
          <Row label="Idioma" value={d.identity.locale} />
          <Row label="Zona horaria" value={d.identity.timezone} />
          <Row label="Documento" value={d.identity.documentId ?? '—'} />
          <Row label="Onboarding" value={formatDate(d.identity.onboardingCompletedAt)} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="text-sm font-semibold text-text">Roles</h3>
          <div className="flex flex-wrap gap-2">
            {d.identity.roles.length === 0 ? (
              <span className="text-sm text-text-muted">Sin roles.</span>
            ) : (
              d.identity.roles.map((r) => (
                <span
                  key={r}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
                >
                  {ROLE_LABELS[r as AssignableRole] ?? r}
                  {r !== 'super_admin' ? (
                    <button
                      type="button"
                      aria-label={`Quitar rol ${r}`}
                      disabled={busy !== null}
                      onClick={() =>
                        void run('role', () =>
                          adminUsersApi.removeRole(token(), d.identity.id, r as AssignableRole),
                        )
                      }
                      className="text-text-muted hover:text-red-600"
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))
            )}
          </div>
          {assignable.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as AssignableRole)}
                className="w-auto"
              >
                {assignable.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r] ?? r}
                  </option>
                ))}
              </NativeSelect>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void run('role', () => adminUsersApi.assignRole(token(), d.identity.id, newRole))
                }
              >
                Añadir rol
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">Sesiones recientes</h3>
        {d.access.recentSessions.length === 0 ? (
          <Empty>Sin sesiones activas.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs uppercase text-text-muted">
                <tr>
                  <th className="py-2">Inicio</th>
                  <th className="py-2">Caduca</th>
                  <th className="py-2">IP</th>
                  <th className="py-2">Dispositivo</th>
                </tr>
              </thead>
              <tbody>
                {d.access.recentSessions.map((s) => (
                  <tr key={s.id} className="border-t border-border-soft">
                    <td className="py-2">{formatDateTime(s.createdAt)}</td>
                    <td className="py-2 text-text-muted">{formatDateTime(s.expiresAt)}</td>
                    <td className="py-2 font-mono text-xs">{s.ip ?? '—'}</td>
                    <td className="max-w-[240px] truncate py-2 text-xs text-text-muted">
                      {s.userAgent ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {d.access.externalIdentities.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text">Identidades externas</h3>
          <ul className="space-y-1 text-sm">
            {d.access.externalIdentities.map((i, idx) => (
              <li key={`${i.provider}-${idx}`} className="flex justify-between gap-2">
                <span>
                  {i.provider} · <span className="text-text-muted">{i.issuer}</span>
                </span>
                <span className="text-text-muted">
                  vinculada {formatDate(i.linkedAt)}
                  {i.lastSeenAt ? ` · vista ${formatDate(i.lastSeenAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SancionesTab({ d }: { d: UserDossier }) {
  if (d.restrictions.length === 0) {
    return <Empty>Nunca ha sido sancionado.</Empty>;
  }
  return (
    <div className="space-y-2">
      {d.restrictions.map((r) => (
        <Card key={r.id}>
          <CardContent className="p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-text">{r.scopeLabels.join(', ')}</span>
              <Badge variant={r.active ? 'warning' : 'muted'}>
                {r.active ? 'Vigente' : r.liftedAt ? 'Levantada' : 'Caducada'}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {formatDateTime(r.createdAt)}
              {r.createdByName ? ` · por ${r.createdByName}` : ''} ·{' '}
              {r.expiresAt ? `hasta ${formatDateTime(r.expiresAt)}` : 'permanente'}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-text-muted">«{r.reason}»</p>
            {r.liftedAt ? (
              <p className="mt-1 text-xs text-text-muted">
                Levantada el {formatDateTime(r.liftedAt)}
                {r.liftedByName ? ` por ${r.liftedByName}` : ''}
                {r.liftReason ? ` — «${r.liftReason}»` : ''}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
