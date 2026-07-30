'use client';

import { Shield, ShieldBan } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { authStorage } from '@/lib/auth-storage';
import {
  expiresAtFromDuration,
  invalidateRestrictionCache,
  restrictionsApi,
  RESTRICTION_DURATIONS,
  RESTRICTION_SCOPES,
  SCOPE_ALL,
  type ActiveRestrictionSummary,
  type DurationValue,
  type Restriction,
} from '@/lib/restrictions';

const ADMIN_ROLES = ['super_admin', 'tenant_admin'];

/**
 * ¿Puede el usuario actual sancionar a `targetUserId`?
 *
 * Es solo UX: el backend revalida en `RestrictionService.create` (incluido que
 * no se pueda sancionar a un super_admin, cosa que aquí no sabemos porque el
 * perfil público no expone roles).
 */
export function useCanModerate(targetUserId: string | null | undefined): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    const check = () => {
      const session = authStorage.getSession();
      const roles = session?.user.roles ?? [];
      const isAdmin = roles.some((r) => ADMIN_ROLES.includes(r));
      setCan(isAdmin && !!targetUserId && targetUserId !== session?.user.id);
    };
    check();
    window.addEventListener('didacta:session-updated', check);
    return () => window.removeEventListener('didacta:session-updated', check);
  }, [targetUserId]);
  return can;
}

/**
 * Escudo de moderación: aparece al lado del nombre de un usuario para admins.
 *
 * Hace doble función a propósito. Gris = sin sanción, y al pulsarlo se abre el
 * diálogo para poner una. Rojo = ya está sancionado, y el mismo diálogo enseña
 * la sanción vigente y permite levantarla. Así se ve de un vistazo quién está
 * sancionado sin abrir nada.
 */
export function RestrictionShield({
  userId,
  userName,
  active,
  size = 16,
  className,
}: {
  userId: string;
  userName: string | null | undefined;
  /** Sanción vigente ya resuelta por el padre (batch). */
  active?: ActiveRestrictionSummary | null;
  size?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const isRestricted = !!active;

  const label = isRestricted
    ? `${userName ?? 'Este usuario'} está sancionado: ${active.scopeLabels.join(', ')}`
    : `Restringir a ${userName ?? 'este usuario'}`;

  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className={[
          'inline-flex shrink-0 items-center justify-center rounded-md p-1 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          isRestricted
            ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
            : 'text-muted-foreground/60 hover:bg-muted hover:text-foreground',
          className ?? '',
        ].join(' ')}
      >
        {isRestricted ? <ShieldBan size={size} /> : <Shield size={size} />}
      </button>
      {open ? (
        <RestrictionDialog userId={userId} userName={userName} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/**
 * Diálogo de sanción. Carga el histórico al abrirse (no antes: sería una
 * petición por cada nombre en pantalla).
 */
export function RestrictionDialog({
  userId,
  userName,
  onClose,
}: {
  userId: string;
  userName: string | null | undefined;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<Restriction[] | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [duration, setDuration] = useState<DurationValue>('7d');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHistory(await restrictionsApi.list(userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el historial.');
      setHistory([]);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeOnes = useMemo(() => (history ?? []).filter((r) => r.active), [history]);

  const toggleScope = (value: string) => {
    setScopes((prev) => {
      if (value === SCOPE_ALL) return prev.includes(SCOPE_ALL) ? [] : [SCOPE_ALL];
      const withoutAll = prev.filter((s) => s !== SCOPE_ALL);
      return withoutAll.includes(value)
        ? withoutAll.filter((s) => s !== value)
        : [...withoutAll, value];
    });
  };

  const submit = async () => {
    setError(null);
    if (scopes.length === 0) {
      setError('Elige al menos un área.');
      return;
    }
    if (!reason.trim()) {
      setError('El motivo es obligatorio: se le muestra a la persona cuando intente publicar.');
      return;
    }
    setBusy(true);
    try {
      await restrictionsApi.create(userId, {
        scopes,
        reason: reason.trim(),
        expiresAt: expiresAtFromDuration(duration),
      });
      invalidateRestrictionCache(userId);
      setScopes([]);
      setReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo aplicar la sanción.');
    } finally {
      setBusy(false);
    }
  };

  const lift = async (restrictionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await restrictionsApi.lift(userId, restrictionId, null);
      invalidateRestrictionCache(userId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo levantar la sanción.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Moderar a ${userName ?? 'este usuario'}`}
      description="Sigue pudiendo entrar y leer. Solo deja de poder aportar contenido en las áreas que marques."
      maxWidthClass="max-w-xl"
    >
      <div className="space-y-5" data-testid="restriction-dialog">
        {activeOnes.length > 0 ? (
          <section className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30">
            <h3 className="text-sm font-semibold text-red-800 dark:text-red-300">
              Sanciones vigentes
            </h3>
            <ul className="mt-2 space-y-2">
              {activeOnes.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{r.scopeLabels.join(', ')}</p>
                    <p className="text-muted-foreground">
                      {r.expiresAt
                        ? `Hasta el ${new Date(r.expiresAt).toLocaleString('es-ES')}`
                        : 'Permanente'}
                      {r.createdByName ? ` · por ${r.createdByName}` : ''}
                    </p>
                    <p className="mt-0.5 break-words text-muted-foreground">«{r.reason}»</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void lift(r.id)}
                    data-testid="lift-restriction"
                  >
                    Levantar
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="space-y-3">
          <div>
            <Label>Áreas a restringir</Label>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {RESTRICTION_SCOPES.map((s) => (
                <label
                  key={s.value}
                  className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopes.includes(s.value)}
                    onChange={() => toggleScope(s.value)}
                    data-testid={`scope-${s.value}`}
                  />
                  <span>
                    <span className="font-medium">{s.label}</span>
                    <span className="block text-xs text-muted-foreground">{s.hint}</span>
                  </span>
                </label>
              ))}
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-dashed p-2 text-sm hover:bg-muted/50 sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={scopes.includes(SCOPE_ALL)}
                  onChange={() => toggleScope(SCOPE_ALL)}
                  data-testid="scope-all"
                />
                <span>
                  <span className="font-medium">Toda la plataforma</span>
                  <span className="block text-xs text-muted-foreground">
                    Todo lo anterior, más el perfil, los comentarios de lección y las entregas de
                    retos. Nunca afecta a pagos ni al curso que ya compró.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div>
            <Label htmlFor="restriction-duration">Duración</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {RESTRICTION_DURATIONS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => setDuration(d.value)}
                  data-testid={`duration-${d.value}`}
                  className={[
                    'rounded-full border px-3 py-1 text-sm transition-colors',
                    duration === d.value
                      ? 'border-brand-500 bg-brand-50 font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                      : 'hover:bg-muted',
                  ].join(' ')}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label htmlFor="restriction-reason">Motivo (obligatorio)</Label>
            <Textarea
              id="restriction-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Ej. Publicaciones promocionales repetidas tras dos avisos."
              data-testid="restriction-reason"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Se le muestra a la persona cuando intente publicar, y queda en el registro de
              auditoría.
            </p>
          </div>

          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              data-testid="apply-restriction"
            >
              {busy ? 'Aplicando…' : 'Aplicar sanción'}
            </Button>
          </div>
        </section>

        {history && history.length > activeOnes.length ? (
          <section>
            <h3 className="text-sm font-semibold">Historial</h3>
            <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
              {history
                .filter((r) => !r.active)
                .map((r) => (
                  <li key={r.id}>
                    <span className="font-medium">{r.scopeLabels.join(', ')}</span> ·{' '}
                    {new Date(r.createdAt).toLocaleDateString('es-ES')}
                    {r.liftedAt
                      ? ` · levantada por ${r.liftedByName ?? 'un admin'}`
                      : ' · caducada'}{' '}
                    · «{r.reason}»
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
