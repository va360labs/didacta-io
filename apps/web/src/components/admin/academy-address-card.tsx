'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  academyAddressApi as defaultApi,
  canSubmitAddress,
  signinUrlAt,
  toLabelDraft,
  type AcademyAddressState,
  type AddressAvailability,
  type AddressHint,
} from '@/lib/academy-address';
import { authStorage as defaultAuthStorage } from '@/lib/auth-storage';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { cn } from '@/lib/utils';

/** Espera tras la última tecla antes de preguntar si está libre. */
const CHECK_DEBOUNCE_MS = 400;
/** Lo que se deja leer el «hecho» antes de llevar a la dirección nueva. */
const REDIRECT_DELAY_MS = 2_500;

export interface AcademyAddressCardProps {
  /**
   * `card` en Configuración del modo completo (pestaña General); `section` en
   * los Ajustes del modo sencillo, con la maqueta de sus secciones.
   */
  variant?: 'card' | 'section';
  /** Inyectables para tests. */
  api?: typeof defaultApi;
  authStorage?: Pick<typeof defaultAuthStorage, 'getAccessToken' | 'clear'>;
  navigate?: (url: string) => void;
}

/**
 * «Dirección de tu academia»: el administrador cambia él solo el subdominio de
 * su aula (`<x>.didacta.io` → `<y>.didacta.io`), con la comprobación de si
 * está libre mientras escribe y una confirmación que deja claras las dos
 * consecuencias: los enlaces viejos siguen funcionando y todo el mundo tiene
 * que volver a entrar en la dirección nueva (la sesión es de cada dirección).
 *
 * No se pinta NADA si la instancia no tiene la función (la API responde 404:
 * sin `TENANT_SUBDOMAIN_SUFFIX`) ni si el aula no tiene dirección de la app.
 */
export function AcademyAddressCard({
  variant = 'card',
  api = defaultApi,
  authStorage = defaultAuthStorage,
  navigate = (url) => window.location.assign(url),
}: AcademyAddressCardProps = {}): React.JSX.Element | null {
  const t = useTranslations('adminMarca.direccionAula');
  const tErrors = useTranslations('errors');
  const [state, setState] = useState<AcademyAddressState | null | 'off'>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  const [checked, setChecked] = useState<AddressAvailability | null>(null);
  const [hint, setHint] = useState<AddressHint>({ kind: 'idle' });
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hostname: string; signinUrl: string } | null>(null);
  const checkSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const token = authStorage.getAccessToken();
    if (!token) {
      setLoadError(true);
      return;
    }
    api
      .getState(token)
      .then((s) => {
        if (cancelled) return;
        setState(s ?? 'off');
        if (s?.label) setDraft(s.label);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, authStorage]);

  // Comprobación en vivo: tras una pausa al escribir, y solo cuenta la
  // respuesta de lo ÚLTIMO que se escribió.
  useEffect(() => {
    if (state === null || state === 'off' || !state.canChange) return;
    const seq = ++checkSeq.current;
    setChecked(null);
    // Lo que ya es su dirección (lo que aparece al abrir) no se comprueba ni
    // se comenta: no hay nada que decir hasta que escriba otra.
    if (!draft || draft === state.label) {
      setHint({ kind: 'idle' });
      return;
    }
    setHint({ kind: 'checking' });
    const timer = setTimeout(() => {
      const token = authStorage.getAccessToken();
      if (!token) return;
      api
        .check(token, draft)
        .then((r) => {
          if (seq !== checkSeq.current) return;
          setChecked(r);
          setHint({ kind: r.status, hostname: r.hostname });
        })
        .catch(() => {
          if (seq === checkSeq.current) setHint({ kind: 'error' });
        });
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, state, api, authStorage]);

  // Sin la función en esta instancia, o un aula sin dirección de la app: nada.
  if (state === 'off' || (state && state.blockedReason === 'no_address')) return null;

  const addr: AcademyAddressState | null = state;

  async function confirmChange() {
    const token = authStorage.getAccessToken();
    if (!token || !checked?.hostname) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.change(token, checked.label);
      const signinUrl = signinUrlAt(res.hostname, window.location);
      setConfirming(false);
      setDone({ hostname: res.hostname, signinUrl });
      setState(res.state);
      setTimeout(() => leaveTo(signinUrl), REDIRECT_DELAY_MS);
    } catch (e) {
      setSaveError(apiErrorMessage(e, tErrors) || t('error'));
    } finally {
      setSaving(false);
    }
  }

  /**
   * A la pantalla de acceso de la dirección nueva. La sesión de esta dirección
   * se borra justo al salir (no antes: sin ella, el resto del panel mandaría
   * al acceso de la VIEJA antes de leer el aviso): sus páginas ya redirigen a
   * la nueva y allí hay que entrar otra vez.
   */
  function leaveTo(url: string) {
    authStorage.clear();
    navigate(url);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (canSubmitAddress(addr, draft, checked, saving)) {
      setSaveError(null);
      setConfirming(true);
    }
  }

  const section = variant === 'section';
  const canSubmit = canSubmitAddress(addr, draft, checked, saving);

  const body = loadError ? (
    <p role="alert" className="text-sm text-danger-700">
      {t('loadError')}
    </p>
  ) : !addr ? (
    <div className="skeleton h-10 w-72" />
  ) : done ? (
    <div role="status" className="flex flex-col gap-3" data-testid="direccion-hecho">
      <p className="inline-flex items-start gap-2 font-semibold text-success-700">
        <Icon name="check" size={18} />
        <span>{t('done', { url: `https://${done.hostname}` })}</span>
      </p>
      <div>
        <Button type="button" onClick={() => leaveTo(done.signinUrl)}>
          {t('goNow')}
        </Button>
      </div>
    </div>
  ) : (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-muted" data-testid="direccion-actual">
        {t('current')}{' '}
        <a
          href={`https://${addr.hostname}`}
          target="_blank"
          rel="noopener"
          className="font-semibold text-brand-700 hover:underline"
        >
          {addr.hostname}
        </a>
      </p>

      {addr.blockedReason === 'own_domain' ? (
        <p className="text-sm text-text-muted" data-testid="direccion-bloqueada">
          {t('ownDomain', { host: addr.hostname ?? '' })}
        </p>
      ) : addr.blockedReason === 'limit' ? (
        <p role="status" className="text-sm text-text-muted" data-testid="direccion-bloqueada">
          {t('limit', {
            max: addr.maxChanges,
            days: addr.windowDays,
            date: addr.nextChangeAt
              ? formatDate(addr.nextChangeAt, { day: 'numeric', month: 'long' })
              : '',
          })}
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="direccion-academia-input" className={section ? 'font-semibold' : ''}>
              {t('label')}
            </Label>
            <div className="flex max-w-xl items-stretch">
              <input
                id="direccion-academia-input"
                data-testid="direccion-input"
                value={draft}
                onChange={(e) => {
                  setDraft(toLabelDraft(e.target.value));
                  setSaveError(null);
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                maxLength={63}
                aria-describedby="direccion-academia-estado"
                aria-invalid={
                  hint.kind === 'invalid' || hint.kind === 'reserved' || hint.kind === 'taken'
                }
                className={cn(
                  'min-w-0 flex-1 border border-r-0 bg-surface px-3.5 text-text outline-none',
                  'aria-[invalid=true]:border-danger-500',
                  // Las dos maquetas de sus pantallas hermanas: el campo del
                  // nombre en Ajustes del sencillo y el `Input` del completo.
                  section
                    ? 'h-12 rounded-l-xl border-border text-[17px] font-semibold focus:border-brand-600 focus:ring-4 focus:ring-brand-100'
                    : 'h-10 rounded-l-lg border-border-strong text-[0.9375rem] focus-visible:border-brand-500 focus-visible:shadow-focus',
                )}
              />
              <span
                className={cn(
                  'inline-flex shrink-0 items-center border bg-bg-subtle px-3 text-text-muted',
                  section
                    ? 'h-12 rounded-r-xl border-border text-[17px]'
                    : 'h-10 rounded-r-lg border-border-strong text-[0.9375rem]',
                )}
              >
                .{addr.suffix}
              </span>
            </div>
            <p
              id="direccion-academia-estado"
              data-testid="direccion-estado"
              data-status={hint.kind}
              aria-live="polite"
              className={cn(
                'min-h-5 text-sm',
                hint.kind === 'available'
                  ? 'font-semibold text-success-700'
                  : hint.kind === 'taken' ||
                      hint.kind === 'reserved' ||
                      hint.kind === 'invalid' ||
                      hint.kind === 'error'
                    ? 'text-danger-700'
                    : 'text-text-muted',
              )}
            >
              {hint.kind === 'idle' ? '' : t(`hint.${hint.kind}`)}
            </p>
          </div>
          <p className="text-sm text-text-subtle">
            {t('left', { left: addr.changesLeft, max: addr.maxChanges, days: addr.windowDays })}
          </p>
          {saveError && !confirming ? (
            <p role="alert" className="text-sm font-semibold text-danger-700">
              {saveError}
            </p>
          ) : null}
          <div>
            <Button type="submit" disabled={!canSubmit} data-testid="direccion-cambiar">
              {t('change')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );

  const dialog =
    addr && checked?.hostname ? (
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (!saving) setConfirming(next);
        }}
        title={t('confirmTitle')}
        ariaLabel={t('confirmTitle')}
      >
        <div
          className="space-y-4 text-[0.9375rem] leading-relaxed"
          data-testid="direccion-confirmar"
        >
          <p>{t('confirmFromTo', { old: addr.hostname ?? '', new: checked.hostname })}</p>
          <ul className="list-disc space-y-2 pl-5 text-text-muted">
            <li>{t('confirmOldLinks')}</li>
            <li className="font-semibold text-text">{t('confirmSignin')}</li>
            <li>{t('confirmShare')}</li>
          </ul>
          {saveError ? (
            <p role="alert" className="text-sm font-semibold text-danger-700">
              {saveError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setConfirming(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              disabled={saving}
              onClick={() => void confirmChange()}
              data-testid="direccion-confirmar-si"
            >
              {saving ? t('saving') : t('confirm')}
            </Button>
          </div>
        </div>
      </Dialog>
    ) : null;

  if (section) {
    return (
      <section
        className="mt-4 rounded-2xl border border-border bg-surface p-4 sm:p-6"
        data-testid="direccion-academia"
      >
        <h2 className="text-lg font-bold text-text">{t('title')}</h2>
        <p className="mt-1 max-w-[60ch] text-sm text-text-muted">{t('description')}</p>
        <div className="mt-4">{body}</div>
        {dialog}
      </section>
    );
  }
  return (
    <Card data-testid="direccion-academia">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
      {dialog}
    </Card>
  );
}
