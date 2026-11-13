'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { useTenantContext } from '@/lib/tenant-context';
import {
  createInscripcion,
  fetchInscripcionConfig,
  requestOtp,
  verifyOtp,
  verifyTelegram,
  type InscripcionVerifier,
  type TelegramAuthPayload,
  type TelegramMembership,
} from '@/lib/inscripcion';

/** Longitud mínima de contraseña exigida por el backend. */
const PASSWORD_MIN_LENGTH = 12;

/** Un paso del wizard. Los de verificación aparecen según la política del tenant. */
interface WizardStep {
  key: InscripcionVerifier | 'datos';
  label: string;
}

declare global {
  interface Window {
    // Callback global que el Telegram Login Widget invoca tras autenticar.
    onTelegramAuth?: (user: TelegramAuthPayload) => void;
  }
}

/**
 * Inyecta el Telegram Login Widget para `botUsername` y notifica la
 * autenticación vía `onAuth`. Crea el `<script>` oficial en un `useEffect`,
 * exponiendo `window.onTelegramAuth` ANTES de inyectarlo (el widget llama a esa
 * función global por nombre). El cleanup remueve el script y limpia el callback.
 */
function TelegramLoginWidget({
  botUsername,
  onAuth,
}: {
  botUsername: string;
  onAuth: (user: TelegramAuthPayload) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Ref para que el callback global siempre llame a la última versión de onAuth
  // sin tener que reinyectar el script en cada render.
  const onAuthRef = useRef(onAuth);
  onAuthRef.current = onAuth;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    window.onTelegramAuth = (user: TelegramAuthPayload) => onAuthRef.current(user);

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute('data-request-access', 'write');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    container.appendChild(script);

    return () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      delete window.onTelegramAuth;
    };
  }, [botUsername]);

  return <div ref={containerRef} className="flex justify-center" />;
}

/**
 * Wizard público de inscripción de miembros con PASOS DINÁMICOS: la política
 * del tenant (endpoint `config`) decide qué verificadores aparecen.
 *   - (si telegram) Telegram: login widget → verifyTelegram → ticket.
 *   - (si otp) Email: OTP (solicitar código → verificar) → verificationToken.
 *   - Datos: nombre, contraseña, bio — y el email aquí cuando NO hay paso OTP
 *     (registro libre o solo-telegram) → createInscripcion con la evidencia
 *     que corresponda.
 * Al completar muestra una pantalla final cuyo mensaje depende de la
 * pertenencia al grupo si Telegram participó (la foto de perfil se difiere al
 * onboarding posterior).
 */
export function InscripcionForm() {
  const t = useTranslations('publicSite');
  const tErrors = useTranslations('errors');
  const { tenant } = useTenantContext();
  // Nombre del tenant resuelto por host, con fallback genérico mientras carga
  // o si el dominio no está mapeado (misma resolución que la cabecera).
  const communityName = tenant?.name ?? t('inscripcion.defaultCommunityName');

  // Configuración del flujo (verificadores y botUsername vienen del backend,
  // nunca hardcodeados).
  const [configLoading, setConfigLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [verifiers, setVerifiers] = useState<InscripcionVerifier[]>([]);
  const [botUsername, setBotUsername] = useState<string | null>(null);

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Paso Telegram.
  const [verifyingTelegram, setVerifyingTelegram] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [inGroup, setInGroup] = useState<TelegramMembership | null>(null);

  // Paso OTP (email verificado) — `email` también se usa en el paso de datos
  // cuando no hay OTP (ahí viaja sin verificar y decide el aprobador).
  const [email, setEmail] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [code, setCode] = useState('');
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [verificationToken, setVerificationToken] = useState<string | null>(null);

  // Paso Datos.
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [bio, setBio] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const hasTelegram = verifiers.includes('telegram');
  const hasOtp = verifiers.includes('otp');
  // El email se pide en el paso de datos cuando ningún paso OTP lo verificó.
  const emailInDatos = !hasOtp;

  const steps = useMemo<WizardStep[]>(
    () => [
      ...(hasTelegram ? [{ key: 'telegram' as const, label: t('inscripcion.stepTelegram') }] : []),
      ...(hasOtp ? [{ key: 'otp' as const, label: t('inscripcion.stepEmail') }] : []),
      { key: 'datos', label: t('inscripcion.stepData') },
    ],
    [hasTelegram, hasOtp, t],
  );
  const currentStep = steps[Math.min(step, steps.length - 1)]!;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const config = await fetchInscripcionConfig();
      if (cancelled) return;
      setConfigured(config.configured);
      setVerifiers(config.verifiers);
      setBotUsername(config.botUsername);
      setConfigLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleTelegramAuth(user: TelegramAuthPayload) {
    setVerifyingTelegram(true);
    setError(null);
    try {
      const res = await verifyTelegram(user);
      setTicket(res.ticket);
      setInGroup(res.inGroup);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('inscripcion.telegramError'),
      );
    } finally {
      setVerifyingTelegram(false);
    }
  }

  async function handleSendOtp() {
    if (email.trim() === '') return;
    if (hasTelegram && !ticket) return;
    setSendingOtp(true);
    setError(null);
    try {
      await requestOtp(email.trim(), hasTelegram ? (ticket ?? undefined) : undefined);
      setOtpSent(true);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('inscripcion.otpSendError'),
      );
    } finally {
      setSendingOtp(false);
    }
  }

  async function handleVerifyOtp() {
    if (code.trim() === '') return;
    if (hasTelegram && !ticket) return;
    setVerifyingOtp(true);
    setError(null);
    try {
      const res = await verifyOtp(
        email.trim(),
        code.trim(),
        hasTelegram ? (ticket ?? undefined) : undefined,
      );
      setVerificationToken(res.verificationToken);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('inscripcion.otpVerifyError'),
      );
    } finally {
      setVerifyingOtp(false);
    }
  }

  async function handleSubmit() {
    // Evidencia según la política: verificationToken (con OTP), ticket +
    // email (solo Telegram) o email a secas (registro libre).
    if (hasOtp && !verificationToken) return;
    if (!hasOtp && hasTelegram && !ticket) return;
    setSubmitting(true);
    setError(null);
    try {
      await createInscripcion({
        name: name.trim(),
        password,
        bio: bio.trim() === '' ? undefined : bio.trim(),
        ...(hasOtp
          ? { verificationToken: verificationToken ?? undefined }
          : {
              email: email.trim(),
              ...(hasTelegram ? { ticket: ticket ?? undefined } : {}),
            }),
      });
      setDone(true);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('inscripcion.submitError'),
      );
      setSubmitting(false);
    }
  }

  // canNext por paso: telegram requiere ticket; otp requiere verificationToken;
  // datos valida nombre + contraseña (+ email si se pide aquí).
  const datosReady =
    name.trim().length > 0 &&
    password.length >= PASSWORD_MIN_LENGTH &&
    (!emailInDatos || email.trim().length > 0);
  const canNext =
    currentStep.key === 'telegram'
      ? ticket !== null
      : currentStep.key === 'otp'
        ? verificationToken !== null
        : datosReady;

  // ── Pantalla final tras crear la solicitud ──────────────────────────────────
  if (done) {
    const finalCopy =
      !hasTelegram || inGroup === 'true'
        ? {
            title: t('inscripcion.donePendingTitle'),
            body: t('inscripcion.donePendingBody'),
          }
        : inGroup === 'false'
          ? {
              title: t('inscripcion.doneNotInGroupTitle', { name: communityName }),
              body: t('inscripcion.doneNotInGroupBody'),
            }
          : {
              title: t('inscripcion.doneUnknownTitle'),
              body: t('inscripcion.doneUnknownBody'),
            };
    return (
      <Card>
        <CardContent className="space-y-3 p-8 text-center">
          <div
            aria-hidden="true"
            className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success-500 text-2xl text-white"
          >
            ✓
          </div>
          <h1 className="font-display text-xl font-bold tracking-tight">{finalCopy.title}</h1>
          <p className="text-sm text-text-muted">{finalCopy.body}</p>
        </CardContent>
      </Card>
    );
  }

  if (configLoading) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-text-muted">
          {t('loading')}
        </CardContent>
      </Card>
    );
  }

  if (!configured) {
    return (
      <div className="space-y-6">
        <header className="text-center">
          <p className="label-uppercase text-text-muted">
            {t('inscripcion.kicker', { name: communityName })}
          </p>
          <h1 className="font-display mt-2 text-2xl font-bold tracking-tight">
            {t('inscripcion.title')}
          </h1>
        </header>
        <Card>
          <CardContent className="p-6">
            <p
              role="alert"
              className="rounded-lg border border-warning-100 bg-warning-50 p-3 text-sm text-warning-700"
            >
              {t('inscripcion.notConfigured')}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="label-uppercase text-text-muted">
          {t('inscripcion.kicker', { name: communityName })}
        </p>
        <h1 className="font-display mt-2 text-2xl font-bold tracking-tight">
          {t('inscripcion.title')}
        </h1>
        <p className="mt-1 text-sm text-text-subtle">
          {steps.length > 1
            ? t('inscripcion.introSteps', { count: steps.length })
            : t('inscripcion.introSingle')}
        </p>
      </header>

      {steps.length > 1 ? (
        <ol className="flex items-center justify-center gap-2">
          {steps.map(({ key, label }, i) => (
            <li key={key} className="flex items-center gap-2">
              <span
                className={
                  'grid h-7 w-7 place-items-center rounded-full text-xs font-bold ' +
                  (i < step
                    ? 'bg-success-500 text-white'
                    : i === step
                      ? 'bg-brand-500 text-white'
                      : 'bg-surface-3 text-text-subtle')
                }
              >
                {i < step ? '✓' : i + 1}
              </span>
              <span className="sr-only">{label}</span>
              {i < steps.length - 1 ? <span className="h-px w-6 bg-border-soft" /> : null}
            </li>
          ))}
        </ol>
      ) : null}

      <Card>
        <CardContent className="space-y-5 p-6">
          {/* ── PASO Telegram ── */}
          {currentStep.key === 'telegram' ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">{t('inscripcion.telegramTitle')}</h2>
                <p className="text-sm text-text-muted">
                  {t('inscripcion.telegramBody', { name: communityName })}
                </p>
              </div>

              {!botUsername ? (
                <p
                  role="alert"
                  className="rounded-lg border border-warning-100 bg-warning-50 p-3 text-sm text-warning-700"
                >
                  {t('inscripcion.notConfigured')}
                </p>
              ) : (
                <>
                  {ticket === null ? (
                    <TelegramLoginWidget botUsername={botUsername} onAuth={handleTelegramAuth} />
                  ) : null}
                  {verifyingTelegram ? (
                    <p className="text-center text-sm text-text-muted">
                      {t('inscripcion.telegramVerifying')}
                    </p>
                  ) : null}
                  {ticket !== null && inGroup !== null ? (
                    inGroup === 'true' ? (
                      <p className="rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700">
                        {t('inscripcion.telegramVerified')}
                      </p>
                    ) : (
                      <p
                        role="status"
                        className="rounded-lg border border-warning-100 bg-warning-50 p-3 text-sm text-warning-700"
                      >
                        {inGroup === 'false'
                          ? t('inscripcion.telegramNotInGroup', { name: communityName })
                          : t('inscripcion.telegramUnknownMembership')}
                      </p>
                    )
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {/* ── PASO OTP por email ── */}
          {currentStep.key === 'otp' ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">{t('inscripcion.otpTitle')}</h2>
                <p className="text-sm text-text-muted">{t('inscripcion.otpBody')}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ins-email">
                  {t('inscripcion.emailLabel')} <span className="text-danger-700">*</span>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="ins-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={verificationToken !== null}
                    placeholder={t('inscripcion.emailPlaceholder')}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={sendingOtp || email.trim() === '' || verificationToken !== null}
                    onClick={() => void handleSendOtp()}
                  >
                    {sendingOtp ? t('inscripcion.sending') : t('inscripcion.sendCode')}
                  </Button>
                </div>
              </div>

              {otpSent && verificationToken === null ? (
                <div className="space-y-1.5">
                  <p className="text-sm text-success-700">{t('inscripcion.codeSent')}</p>
                  <Label htmlFor="ins-otp">{t('inscripcion.codeLabel')}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="ins-otp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      placeholder={t('inscripcion.codePlaceholder')}
                    />
                    <Button
                      type="button"
                      disabled={verifyingOtp || code.trim().length === 0}
                      onClick={() => void handleVerifyOtp()}
                    >
                      {verifyingOtp ? t('inscripcion.verifying') : t('inscripcion.verify')}
                    </Button>
                  </div>
                </div>
              ) : null}

              {verificationToken !== null ? (
                <p className="rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700">
                  {t('inscripcion.emailVerified')}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* ── PASO Datos de la cuenta ── */}
          {currentStep.key === 'datos' ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">{t('inscripcion.dataTitle')}</h2>
                <p className="text-sm text-text-muted">{t('inscripcion.dataBody')}</p>
              </div>

              {emailInDatos ? (
                <div className="space-y-1.5">
                  <Label htmlFor="ins-email-datos">
                    {t('inscripcion.emailLabel')} <span className="text-danger-700">*</span>
                  </Label>
                  <Input
                    id="ins-email-datos"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('inscripcion.emailPlaceholder')}
                  />
                  <p className="text-xs text-text-subtle">{t('inscripcion.emailNoticeHint')}</p>
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="ins-name">
                  {t('inscripcion.nameLabel')} <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="ins-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  placeholder={t('inscripcion.namePlaceholder')}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ins-password">
                  {t('inscripcion.passwordLabel')} <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="ins-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('inscripcion.passwordPlaceholder', {
                    count: PASSWORD_MIN_LENGTH,
                  })}
                />
                <p className="text-xs text-text-subtle">
                  {t('inscripcion.passwordHint', { count: PASSWORD_MIN_LENGTH })}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ins-bio">
                  {t('inscripcion.bioLabel')}{' '}
                  <span className="text-text-subtle text-xs">{t('inscripcion.optional')}</span>
                </Label>
                <Textarea
                  id="ins-bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={280}
                  rows={3}
                  placeholder={t('inscripcion.bioPlaceholder')}
                />
                <p className="text-right text-xs text-text-subtle">{bio.length}/280</p>
              </div>
            </div>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={step === 0 || submitting}
              onClick={() => {
                setError(null);
                setStep((s) => Math.max(0, s - 1));
              }}
            >
              {t('inscripcion.back')}
            </Button>
            {step < steps.length - 1 ? (
              <Button
                type="button"
                disabled={!canNext}
                onClick={() => {
                  setError(null);
                  setStep((s) => s + 1);
                }}
              >
                {t('inscripcion.continue')}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={!canNext || submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? t('inscripcion.creating') : t('inscripcion.createRequest')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
