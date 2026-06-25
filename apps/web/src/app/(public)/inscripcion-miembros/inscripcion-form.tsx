'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTenantContext } from '@/lib/tenant-context';
import {
  createInscripcion,
  fetchInscripcionConfig,
  inscripcionErrorMessage,
  requestOtp,
  verifyOtp,
  verifyTelegram,
  type TelegramAuthPayload,
  type TelegramMembership,
} from '@/lib/inscripcion';

const STEPS = ['Telegram', 'Email', 'Tus datos'];

/** Longitud mínima de contraseña exigida por el backend. */
const PASSWORD_MIN_LENGTH = 12;

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

/** Aviso según el estado de pertenencia al grupo de Telegram. */
function membershipNotice(inGroup: TelegramMembership): string | null {
  if (inGroup === 'false') {
    return 'No estás en el grupo de VA360, pero puedes solicitar acceso igual; revisaremos tu caso.';
  }
  if (inGroup === 'unknown') {
    return 'No pudimos verificar tu pertenencia ahora; puedes continuar y revisaremos tu caso.';
  }
  return null;
}

/**
 * Wizard público de inscripción de miembros en 3 pasos:
 *   0 — Telegram: login widget → verifyTelegram → ticket + pertenencia.
 *   1 — Email: OTP (solicitar código → verificar) → verificationToken.
 *   2 — Datos: nombre, contraseña y bio → createInscripcion.
 * Al completar muestra una pantalla final cuyo mensaje depende de la
 * pertenencia al grupo (la foto de perfil se difiere al onboarding posterior).
 */
export function InscripcionForm() {
  const { tenant } = useTenantContext();

  // Configuración del flujo (botUsername viene del backend, nunca hardcodeado).
  const [configLoading, setConfigLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [botUsername, setBotUsername] = useState<string | null>(null);

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Paso 0 — Telegram.
  const [verifyingTelegram, setVerifyingTelegram] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [inGroup, setInGroup] = useState<TelegramMembership | null>(null);

  // Paso 1 — OTP.
  const [email, setEmail] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [code, setCode] = useState('');
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [verificationToken, setVerificationToken] = useState<string | null>(null);

  // Paso 2 — Datos.
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [bio, setBio] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const config = await fetchInscripcionConfig();
      if (cancelled) return;
      setConfigured(config.configured);
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
        inscripcionErrorMessage(
          e,
          'No pudimos verificar tu cuenta de Telegram. Inténtalo de nuevo.',
        ),
      );
    } finally {
      setVerifyingTelegram(false);
    }
  }

  async function handleSendOtp() {
    if (!ticket || email.trim() === '') return;
    setSendingOtp(true);
    setError(null);
    try {
      await requestOtp(email.trim(), ticket);
      setOtpSent(true);
    } catch (e) {
      setError(
        inscripcionErrorMessage(
          e,
          'No pudimos enviar el código. Revisa tu email e inténtalo de nuevo.',
        ),
      );
    } finally {
      setSendingOtp(false);
    }
  }

  async function handleVerifyOtp() {
    if (!ticket || code.trim() === '') return;
    setVerifyingOtp(true);
    setError(null);
    try {
      const res = await verifyOtp(email.trim(), code.trim(), ticket);
      setVerificationToken(res.verificationToken);
    } catch (e) {
      setError(inscripcionErrorMessage(e, 'El código no es válido o expiró. Solicita uno nuevo.'));
    } finally {
      setVerifyingOtp(false);
    }
  }

  async function handleSubmit() {
    if (!verificationToken) return;
    setSubmitting(true);
    setError(null);
    try {
      await createInscripcion({
        name: name.trim(),
        password,
        bio: bio.trim() === '' ? undefined : bio.trim(),
        verificationToken,
      });
      setDone(true);
    } catch (e) {
      setError(
        inscripcionErrorMessage(
          e,
          'No pudimos crear tu solicitud. Revisa tus datos e inténtalo de nuevo.',
        ),
      );
      setSubmitting(false);
    }
  }

  // canNext por paso: 0 requiere ticket; 1 requiere verificationToken; 2 valida en submit.
  const canNext =
    step === 0
      ? ticket !== null
      : step === 1
        ? verificationToken !== null
        : name.trim().length > 0 && password.length >= PASSWORD_MIN_LENGTH;

  // ── Pantalla final tras crear la solicitud ──────────────────────────────────
  if (done) {
    const finalCopy =
      inGroup === 'true'
        ? {
            title: 'Registro pendiente de validación',
            body: 'Recibimos tu solicitud. Un administrador la revisará y te avisaremos por email cuando tengas acceso.',
          }
        : inGroup === 'false'
          ? {
              title: 'No estás en el grupo de VA360.pro',
              body: 'Recibimos tu solicitud igualmente. Revisaremos tu caso y te avisaremos por email.',
            }
          : {
              title: 'Solicitud recibida',
              body: 'No pudimos verificar tu pertenencia al grupo, pero recibimos tu solicitud. Revisaremos tu caso y te avisaremos por email.',
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

  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="label-uppercase text-text-muted">
          Inscripción a {tenant?.name ?? 'la comunidad'}
        </p>
        <h1 className="font-display mt-2 text-2xl font-bold tracking-tight">Solicita tu acceso</h1>
        <p className="mt-1 text-sm text-text-subtle">
          Verifica tu identidad y crea tu solicitud en tres pasos.
        </p>
      </header>

      <ol className="flex items-center justify-center gap-2">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
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
            {i < STEPS.length - 1 ? <span className="h-px w-6 bg-border-soft" /> : null}
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="space-y-5 p-6">
          {/* ── PASO 0 — Telegram ── */}
          {step === 0 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Verifica tu Telegram</h2>
                <p className="text-sm text-text-muted">
                  Usamos Telegram para confirmar tu identidad y tu pertenencia al grupo de VA360.
                </p>
              </div>

              {configLoading ? (
                <p className="text-center text-sm text-text-muted">Cargando…</p>
              ) : !configured || !botUsername ? (
                <p
                  role="alert"
                  className="rounded-lg border border-warning-100 bg-warning-50 p-3 text-sm text-warning-700"
                >
                  La inscripción no está disponible en este momento. Vuelve a intentarlo más tarde.
                </p>
              ) : (
                <>
                  {ticket === null ? (
                    <TelegramLoginWidget botUsername={botUsername} onAuth={handleTelegramAuth} />
                  ) : null}
                  {verifyingTelegram ? (
                    <p className="text-center text-sm text-text-muted">Verificando tu cuenta…</p>
                  ) : null}
                  {ticket !== null && inGroup !== null ? (
                    inGroup === 'true' ? (
                      <p className="rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700">
                        Tu cuenta de Telegram quedó verificada. Continúa al siguiente paso.
                      </p>
                    ) : (
                      <p
                        role="status"
                        className="rounded-lg border border-warning-100 bg-warning-50 p-3 text-sm text-warning-700"
                      >
                        {membershipNotice(inGroup)}
                      </p>
                    )
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {/* ── PASO 1 — OTP por email ── */}
          {step === 1 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Verifica tu email</h2>
                <p className="text-sm text-text-muted">
                  Te enviaremos un código de 6 dígitos para confirmar tu correo.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ins-email">
                  Email <span className="text-danger-700">*</span>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="ins-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={verificationToken !== null}
                    placeholder="tu@email.com"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={sendingOtp || email.trim() === '' || verificationToken !== null}
                    onClick={() => void handleSendOtp()}
                  >
                    {sendingOtp ? 'Enviando…' : 'Enviar código'}
                  </Button>
                </div>
              </div>

              {otpSent && verificationToken === null ? (
                <div className="space-y-1.5">
                  <p className="text-sm text-success-700">Código enviado a tu email.</p>
                  <Label htmlFor="ins-otp">Código de 6 dígitos</Label>
                  <div className="flex gap-2">
                    <Input
                      id="ins-otp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                    />
                    <Button
                      type="button"
                      disabled={verifyingOtp || code.trim().length === 0}
                      onClick={() => void handleVerifyOtp()}
                    >
                      {verifyingOtp ? 'Verificando…' : 'Verificar'}
                    </Button>
                  </div>
                </div>
              ) : null}

              {verificationToken !== null ? (
                <p className="rounded-lg border border-success-100 bg-success-50 p-3 text-sm text-success-700">
                  Email verificado. Continúa al siguiente paso.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* ── PASO 2 — Datos de la cuenta ── */}
          {step === 2 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Tus datos</h2>
                <p className="text-sm text-text-muted">
                  Con esto creamos tu solicitud. Podrás completar tu perfil al entrar.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ins-name">
                  Nombre <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="ins-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  placeholder="Tu nombre"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ins-password">
                  Contraseña <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="ins-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 12 caracteres"
                />
                <p className="text-xs text-text-subtle">
                  Usa al menos {PASSWORD_MIN_LENGTH} caracteres. Combina letras, números y símbolos.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ins-bio">
                  Biografía <span className="text-text-subtle text-xs">(opcional)</span>
                </Label>
                <Textarea
                  id="ins-bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={280}
                  rows={3}
                  placeholder="Cuéntanos algo sobre ti (máx 280 caracteres)"
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
              Atrás
            </Button>
            {step < STEPS.length - 1 ? (
              <Button
                type="button"
                disabled={!canNext}
                onClick={() => {
                  setError(null);
                  setStep((s) => s + 1);
                }}
              >
                Continuar
              </Button>
            ) : (
              <Button
                type="button"
                disabled={!canNext || submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? 'Creando…' : 'Crear solicitud'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
