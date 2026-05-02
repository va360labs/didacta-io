'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

type Step = 'welcome' | 'organization' | 'modules' | 'admin' | 'creating' | 'tour';

interface InitResponse {
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  user: {
    id: string;
    email: string;
    name: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
  };
}

interface AvailableModule {
  name: string;
  displayName: string;
  description: string | null;
  /// Módulos `category='core'` (theming, courses, learning…) — pre-marcados
  /// y disabled. NO se pueden desactivar; el wizard los muestra para que el
  /// operador entienda qué viene de fábrica.
  isCore: boolean;
  enabledByDefault: boolean;
}

function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
}

function evaluatePassword(pw: string): PasswordStrength {
  if (pw.length === 0) return { score: 0, label: '', hint: '' };
  if (pw.length < 12) {
    return {
      score: 1,
      label: 'Muy corta',
      hint: 'Mínimo 12 caracteres.',
    };
  }
  let variety = 0;
  if (/[a-z]/.test(pw)) variety++;
  if (/[A-Z]/.test(pw)) variety++;
  if (/\d/.test(pw)) variety++;
  if (/[^a-zA-Z0-9]/.test(pw)) variety++;
  const long = pw.length >= 16;
  if (variety <= 2) return { score: 2, label: 'Aceptable', hint: 'Mezcla mayúsculas, números y símbolos.' };
  if (variety === 3 && !long) return { score: 3, label: 'Buena', hint: 'Si la haces más larga, mejor.' };
  return { score: 4, label: 'Excelente', hint: '' };
}

export function SetupWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('welcome');
  const [error, setError] = useState<string | null>(null);

  // Org
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [hostname, setHostname] = useState('');

  // Modules — disponibles + selección del operador
  const [availableModules, setAvailableModules] = useState<AvailableModule[] | null>(null);
  const [selectedModules, setSelectedModules] = useState<Set<string>>(new Set());
  const [modulesError, setModulesError] = useState<string | null>(null);

  // Admin
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState('');

  // Pre-relleno hostname tras montar (window solo en cliente).
  useEffect(() => {
    if (typeof window !== 'undefined' && !hostname) {
      setHostname(window.location.host);
    }
  }, [hostname]);

  // Carga la lista de módulos al entrar en el step `modules` por primera
  // vez. Inicializa `selectedModules` con los `enabledByDefault=true`
  // (los core se mandan siempre, no necesitan estar en el set — pero los
  // incluimos por claridad UX para que el resumen del request sea
  // explícito si en el futuro se loguea).
  useEffect(() => {
    if (step !== 'modules' || availableModules !== null) return;
    let cancelled = false;
    apiFetch<{ modules: AvailableModule[] }>('/api/v1/setup/available-modules', {
      method: 'GET',
    })
      .then((res) => {
        if (cancelled) return;
        setAvailableModules(res.modules);
        const initial = new Set<string>();
        for (const m of res.modules) {
          if (m.isCore || m.enabledByDefault) initial.add(m.name);
        }
        setSelectedModules(initial);
      })
      .catch((e) => {
        if (cancelled) return;
        setModulesError(
          e instanceof ApiHttpError
            ? e.message
            : 'No pudimos cargar la lista de módulos. Intenta de nuevo.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [step, availableModules]);

  // Auto-slug mientras el usuario no lo haya editado a mano.
  useEffect(() => {
    if (!slugTouched) {
      setOrgSlug(slugify(orgName));
    }
  }, [orgName, slugTouched]);

  const passwordStrength = useMemo(() => evaluatePassword(adminPassword), [adminPassword]);
  const passwordsMatch = adminPassword === adminPasswordConfirm;

  const orgValid = orgName.trim().length > 0 && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(orgSlug);
  const adminValid =
    adminName.trim().length > 0 &&
    /.+@.+\..+/.test(adminEmail) &&
    adminPassword.length >= 12 &&
    passwordsMatch;

  async function submitInit() {
    setStep('creating');
    setError(null);
    try {
      const response = await apiFetch<InitResponse>('/api/v1/setup/init', {
        method: 'POST',
        body: JSON.stringify({
          organization: {
            name: orgName.trim(),
            slug: orgSlug,
            primaryHostname: hostname.trim() || undefined,
          },
          admin: {
            name: adminName.trim(),
            email: adminEmail.trim(),
            password: adminPassword,
          },
          // Si el operador llegó al step de módulos, mandamos su selección.
          // Si saltó del step (caso fallback / API caída al cargar la lista),
          // omitimos el campo para que el backend aplique los `enabledByDefault`.
          enabledModules: availableModules ? Array.from(selectedModules) : undefined,
        }),
      });
      authStorage.saveTokens(response.tokens.accessToken, response.tokens.refreshToken);
      authStorage.saveSession({
        user: response.user,
        mfaRequired: false,
      });
      setStep('tour');
    } catch (e) {
      let msg = 'No pudimos completar la configuración. Prueba de nuevo en unos segundos.';
      if (e instanceof ApiHttpError) {
        if (e.status === 409) {
          msg =
            'Esta plataforma ya fue inicializada. Vuelve a la pantalla de inicio de sesión y entra con tu cuenta admin.';
        } else if (e.message) {
          msg = e.message;
        }
      }
      setError(msg);
      setStep('admin');
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="mb-10 text-center">
        <p className="label-uppercase text-text-muted">CONFIGURACIÓN</p>
        <h1 className="font-display mt-2 text-4xl font-extrabold tracking-tight text-brand-700">
          Didacta
        </h1>
        <p className="mt-1 text-sm text-text-subtle">
          Plataforma educativa abierta y modular — configuración inicial
        </p>
      </header>

      <ProgressIndicator step={step} />

      <section className="mt-8 rounded-2xl border border-border-soft bg-surface p-6 shadow-sm sm:p-10">
        {step === 'welcome' && (
          <StepWelcome onContinue={() => setStep('organization')} />
        )}

        {step === 'organization' && (
          <StepOrganization
            name={orgName}
            slug={orgSlug}
            hostname={hostname}
            showAdvanced={showAdvanced}
            onChangeName={setOrgName}
            onChangeSlug={(v) => {
              setSlugTouched(true);
              setOrgSlug(v);
            }}
            onChangeHostname={setHostname}
            onToggleAdvanced={() => setShowAdvanced((v) => !v)}
            onBack={() => setStep('welcome')}
            onContinue={() => setStep('modules')}
            canContinue={orgValid}
          />
        )}

        {step === 'modules' && (
          <StepModules
            modules={availableModules}
            selected={selectedModules}
            error={modulesError}
            onToggle={(name) => {
              setSelectedModules((prev) => {
                const next = new Set(prev);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
              });
            }}
            onBack={() => setStep('organization')}
            onContinue={() => setStep('admin')}
          />
        )}

        {(step === 'admin' || step === 'creating') && (
          <StepAdmin
            name={adminName}
            email={adminEmail}
            password={adminPassword}
            passwordConfirm={adminPasswordConfirm}
            strength={passwordStrength}
            passwordsMatch={passwordsMatch}
            onChangeName={setAdminName}
            onChangeEmail={setAdminEmail}
            onChangePassword={setAdminPassword}
            onChangePasswordConfirm={setAdminPasswordConfirm}
            onBack={() => setStep('modules')}
            onSubmit={submitInit}
            canSubmit={adminValid && step === 'admin'}
            submitting={step === 'creating'}
            error={error}
          />
        )}

        {step === 'tour' && <StepTour onFinish={() => router.push('/cursos')} />}
      </section>

      <footer className="mt-8 text-center text-xs text-text-subtle">
        Esta pantalla solo aparece la primera vez. Tras crear tu cuenta admin puedes
        invitar al resto de tu equipo desde Configuración → Usuarios.
      </footer>
    </div>
  );
}

function ProgressIndicator({ step }: { step: Step }) {
  const steps: { id: Step | 'creating'; label: string }[] = [
    { id: 'welcome', label: 'Bienvenida' },
    { id: 'organization', label: 'Organización' },
    { id: 'modules', label: 'Módulos' },
    { id: 'admin', label: 'Tu cuenta' },
    { id: 'tour', label: 'Listo' },
  ];
  const order: Step[] = ['welcome', 'organization', 'modules', 'admin', 'tour'];
  const currentIdx = order.indexOf(step === 'creating' ? 'admin' : step);
  return (
    <ol className="flex items-center justify-center gap-2 sm:gap-4">
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={[
                'inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-colors',
                done
                  ? 'bg-brand-500 text-text-on-brand'
                  : active
                    ? 'border-2 border-brand-500 bg-surface text-brand-700'
                    : 'border border-border-strong bg-surface text-text-subtle',
              ].join(' ')}
              aria-current={active ? 'step' : undefined}
            >
              {done ? '✓' : i + 1}
            </span>
            <span
              className={[
                'hidden text-sm font-medium sm:inline',
                active ? 'text-text' : 'text-text-subtle',
              ].join(' ')}
            >
              {s.label}
            </span>
            {i < steps.length - 1 ? (
              <span
                className={[
                  'mx-1 h-px w-6 sm:w-12 transition-colors',
                  done ? 'bg-brand-500' : 'bg-border-strong',
                ].join(' ')}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function StepWelcome({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">Bienvenido a Didacta</h2>
        <p className="mt-2 text-sm text-text-muted">
          Acabas de instalar tu propia copia de la plataforma. En menos de un minuto vas a tener tu
          organización configurada y vas a poder empezar a crear cursos, invitar formadores y
          gestionar alumnos.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Bullet title="Tuyo, sin compromisos">
          Self-hosted, código abierto. Tus datos viven en tu infraestructura.
        </Bullet>
        <Bullet title="Modular">
          Activa solo los módulos que necesites: cursos, comunidad, FUNDAE, certificados, IA…
        </Bullet>
        <Bullet title="Multi-tenant">
          Una instancia, múltiples organizaciones aisladas con RLS de Postgres.
        </Bullet>
        <Bullet title="Open-core">
          La community es libre. Las features Enterprise se activan con licencia.
        </Bullet>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={onContinue} size="lg">
          Empezar configuración
        </Button>
      </div>
    </div>
  );
}

function Bullet({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-soft bg-surface-2 p-4">
      <p className="text-sm font-semibold text-text">{title}</p>
      <p className="mt-1 text-xs text-text-muted">{children}</p>
    </div>
  );
}

function StepOrganization(props: {
  name: string;
  slug: string;
  hostname: string;
  showAdvanced: boolean;
  onChangeName: (v: string) => void;
  onChangeSlug: (v: string) => void;
  onChangeHostname: (v: string) => void;
  onToggleAdvanced: () => void;
  onBack: () => void;
  onContinue: () => void;
  canContinue: boolean;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">Tu organización</h2>
        <p className="mt-1 text-sm text-text-muted">
          Datos básicos del tenant principal. Puedes añadir más organizaciones después desde el panel
          de super_admin.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="orgName">
            Nombre de la organización <span className="text-danger-700">*</span>
          </Label>
          <Input
            id="orgName"
            value={props.name}
            onChange={(e) => props.onChangeName(e.target.value)}
            placeholder="Academia Didacta"
            autoFocus
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="hostname">Dominio público</Label>
          <Input
            id="hostname"
            value={props.hostname}
            onChange={(e) => props.onChangeHostname(e.target.value)}
            placeholder="didacta.miempresa.com"
          />
          <p className="text-xs text-text-subtle">
            Detectado automáticamente. Cambialo si vas a acceder por otro dominio o si configurás un
            CDN delante.
          </p>
        </div>

        <button
          type="button"
          onClick={props.onToggleAdvanced}
          className="flex items-center gap-2 text-xs font-semibold text-text-muted hover:text-text"
        >
          <span aria-hidden="true">{props.showAdvanced ? '▾' : '▸'}</span>
          Configuración avanzada
        </button>

        {props.showAdvanced ? (
          <div className="space-y-1.5 rounded-lg border border-border-soft bg-surface-2 p-4">
            <Label htmlFor="orgSlug">Slug del tenant</Label>
            <Input
              id="orgSlug"
              value={props.slug}
              onChange={(e) => props.onChangeSlug(e.target.value)}
              placeholder="academia-didacta"
            />
            <p className="text-xs text-text-subtle">
              Identificador interno (DNS-safe). Lo usa la API y es visible si tienes que iniciar
              sesión sin pasar por tu dominio. Por defecto se autogenera del nombre.
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 pt-2">
        <Button variant="ghost" onClick={props.onBack}>
          Atrás
        </Button>
        <Button onClick={props.onContinue} disabled={!props.canContinue} size="lg">
          Continuar
        </Button>
      </div>
    </div>
  );
}

function StepModules(props: {
  modules: AvailableModule[] | null;
  selected: Set<string>;
  error: string | null;
  onToggle: (name: string) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { modules, selected, error, onToggle, onBack, onContinue } = props;
  const loading = modules === null && error === null;
  // Separamos core (no-toggleables, informativos) de los opcionales para
  // que el operador entienda visualmente qué viene siempre y qué decide él.
  const coreModules = modules?.filter((m) => m.isCore) ?? [];
  const optionalModules = modules?.filter((m) => !m.isCore) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">Activa los módulos que vas a usar</h2>
        <p className="mt-2 text-sm text-text-muted">
          Esto define qué áreas de la plataforma están disponibles para tu organización al
          arrancar. Los marcados aquí quedan activos por defecto en tu tenant; cualquiera puede
          activarse o desactivarse después desde Configuración → Módulos.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-danger-300 bg-danger-50 p-3 text-sm text-danger-900">
          {error}
        </div>
      )}

      {loading && (
        <p className="text-sm text-text-muted">Cargando módulos disponibles…</p>
      )}

      {coreModules.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-subtle">
            Núcleo (siempre activos)
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {coreModules.map((m) => (
              <ModuleCard key={m.name} module={m} checked={true} disabled={true} onToggle={() => {}} />
            ))}
          </div>
        </section>
      )}

      {optionalModules.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-subtle">
            Módulos opcionales
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {optionalModules.map((m) => (
              <ModuleCard
                key={m.name}
                module={m}
                checked={selected.has(m.name)}
                disabled={false}
                onToggle={() => onToggle(m.name)}
              />
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
        <Button variant="secondary" onClick={onBack}>
          Atrás
        </Button>
        <Button onClick={onContinue} disabled={loading}>
          Continuar
        </Button>
      </div>
    </div>
  );
}

function ModuleCard(props: {
  module: AvailableModule;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { module, checked, disabled, onToggle } = props;
  return (
    <label
      className={[
        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
        checked ? 'border-brand-500 bg-brand-50' : 'border-border bg-surface hover:border-border-strong',
        disabled ? 'cursor-not-allowed opacity-80' : '',
      ].join(' ')}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        className="mt-1 h-4 w-4 rounded border-border-strong text-brand-500 focus:ring-brand-500"
      />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-text">{module.displayName}</span>
        <code className="text-xs text-text-subtle">{module.name}</code>
        {module.description && (
          <p className="mt-1 text-xs text-text-muted">{module.description}</p>
        )}
      </div>
    </label>
  );
}

function StepAdmin(props: {
  name: string;
  email: string;
  password: string;
  passwordConfirm: string;
  strength: PasswordStrength;
  passwordsMatch: boolean;
  onChangeName: (v: string) => void;
  onChangeEmail: (v: string) => void;
  onChangePassword: (v: string) => void;
  onChangePasswordConfirm: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  submitting: boolean;
  error: string | null;
}) {
  const meterColor = [
    'bg-border-strong',
    'bg-danger-500',
    'bg-warning-500',
    'bg-brand-500',
    'bg-success-500',
  ][props.strength.score];
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">Tu cuenta de administrador</h2>
        <p className="mt-1 text-sm text-text-muted">
          Esta cuenta tiene acceso completo a la plataforma. Guarda la contraseña en un gestor: por
          motivos de seguridad no podemos recuperarla por email todavía si eres el único admin.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="adminName">
            Nombre completo <span className="text-danger-700">*</span>
          </Label>
          <Input
            id="adminName"
            value={props.name}
            onChange={(e) => props.onChangeName(e.target.value)}
            placeholder="Tu nombre"
            autoFocus
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="adminEmail">
            Email <span className="text-danger-700">*</span>
          </Label>
          <Input
            id="adminEmail"
            type="email"
            value={props.email}
            onChange={(e) => props.onChangeEmail(e.target.value)}
            autoComplete="email"
            placeholder="admin@miempresa.com"
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="adminPassword">
            Contraseña <span className="text-danger-700">*</span>
          </Label>
          <Input
            id="adminPassword"
            type="password"
            value={props.password}
            onChange={(e) => props.onChangePassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
          {props.password.length > 0 ? (
            <div className="space-y-1">
              <div className="flex h-1.5 w-full gap-1">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className={[
                      'flex-1 rounded-full transition-colors',
                      i < props.strength.score ? meterColor : 'bg-border-soft',
                    ].join(' ')}
                  />
                ))}
              </div>
              <p className="text-xs text-text-subtle">
                <span className="font-medium text-text">{props.strength.label}</span>
                {props.strength.hint ? <span> · {props.strength.hint}</span> : null}
              </p>
            </div>
          ) : (
            <p className="text-xs text-text-subtle">Mínimo 12 caracteres.</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="adminPasswordConfirm">
            Confirmar contraseña <span className="text-danger-700">*</span>
          </Label>
          <Input
            id="adminPasswordConfirm"
            type="password"
            value={props.passwordConfirm}
            onChange={(e) => props.onChangePasswordConfirm(e.target.value)}
            autoComplete="new-password"
            aria-invalid={props.passwordConfirm.length > 0 && !props.passwordsMatch}
            required
          />
          {props.passwordConfirm.length > 0 && !props.passwordsMatch ? (
            <p className="text-xs text-danger-700">Las contraseñas no coinciden.</p>
          ) : null}
        </div>
      </div>

      {props.error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {props.error}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-2">
        <Button variant="ghost" onClick={props.onBack} disabled={props.submitting}>
          Atrás
        </Button>
        <Button onClick={props.onSubmit} disabled={!props.canSubmit} size="lg">
          {props.submitting ? 'Creando…' : 'Crear plataforma'}
        </Button>
      </div>
    </div>
  );
}

function StepTour({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">¡Listo! Esto es lo que viene</h2>
        <p className="mt-1 text-sm text-text-muted">
          Tu instancia ya está activa. Aquí los tres lugares donde vas a pasar más tiempo al
          principio:
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <TourCard icon="📚" title="Cursos">
          Crea tu primer curso, organiza módulos y matricula alumnos. Es donde vive el contenido.
        </TourCard>
        <TourCard icon="💬" title="Comunidad">
          Foros y feed por curso. Útil cuando quieres que los alumnos colaboren y resuelvan dudas
          entre ellos.
        </TourCard>
        <TourCard icon="⚙️" title="Administración">
          Usuarios, roles, branding, módulos activos, integraciones. Todo lo de la organización
          vive bajo /admin.
        </TourCard>
      </div>

      <div className="rounded-lg border border-brand-200 bg-brand-50 p-4 text-sm text-text">
        <p className="font-semibold text-brand-700">Próximo paso recomendado</p>
        <p className="mt-1 text-text-muted">
          Activa MFA para tu cuenta admin desde <span className="font-mono text-xs">/cuenta/seguridad</span>{' '}
          en cuanto entres. Es lo único que te separa del resto del mundo.
        </p>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={onFinish} size="lg">
          Empezar
        </Button>
      </div>
    </div>
  );
}

function TourCard({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-soft bg-surface-2 p-4">
      <div className="mb-2 text-2xl" aria-hidden="true">
        {icon}
      </div>
      <p className="text-sm font-semibold text-text">{title}</p>
      <p className="mt-1 text-xs text-text-muted">{children}</p>
    </div>
  );
}
