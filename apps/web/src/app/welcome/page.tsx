'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { simpleModeApi, useSimpleMode } from '@/lib/simple-mode';
import { AltaSencilla } from './alta-sencilla';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PaymentsConnectCard } from '@/components/admin/payments-connect-card';
import { SmtpSettingsCard } from '@/components/admin/smtp-settings-card';
import { StripeSettingsCard } from '@/components/admin/stripe-settings-card';
import { Icon, type IconName } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authStorage } from '@/lib/auth-storage';
import {
  academyApi,
  ajustarAlModo,
  cobrosConectados,
  concederPaseDeBienvenida,
  destinos,
  onboardingApi,
  onboardingSteps,
  pasosContables,
  PASOS_OBLIGATORIOS,
  paymentsSetupOf,
  retirarPaseDeBienvenida,
  tarjetaDeCobros,
  VACIO,
  type Academy,
  type OnboardingProgress,
  type OnboardingStep,
} from '@/lib/academy';
import { derivePayoutsCardView, payoutsApi, type PayoutsStatusDto } from '@/lib/payouts';
import {
  publishThemeUpdate,
  themingApi,
  type LogoDisplayMode,
  type TenantTheme,
} from '@/lib/theming';
import { PasoAlumnos } from './paso-alumnos';
import { PasoCurso } from './paso-curso';
import { PasoMarca } from './paso-marca';

/** El rail de progreso: icono y etiqueta de cada paso contable, en orden. */
const RAIL: Array<{ paso: OnboardingStep; icono: IconName; clave: string }> = [
  { paso: 'nombre', icono: 'edit', clave: 'pasoNombre' },
  { paso: 'marca', icono: 'palette', clave: 'pasoMarca' },
  { paso: 'curso', icono: 'book', clave: 'pasoCurso' },
  { paso: 'alumnos', icono: 'users', clave: 'pasoAlumnos' },
  { paso: 'cobros', icono: 'trending', clave: 'pasoCobros' },
  { paso: 'correo', icono: 'mail', clave: 'pasoCorreo' },
];

/**
 * Estado de los cobros de plataforma, o `null` (= el asistente de siempre).
 * Un fallo al preguntar NUNCA bloquea: se cae al modo de claves propias.
 *
 * Con `sync` se le pide a la API que lo consulte en Stripe. Se usa cuando el
 * asistente estaba en el paso de cobros: vuelve de terminar el alta en Stripe
 * (su `return_url` es Cobros, y el gate de la academia lo devuelve aquí) y el
 * estado guardado puede no haberse enterado aún.
 */
async function leerCobrosDePlataforma(sync: boolean): Promise<PayoutsStatusDto | null> {
  try {
    return await payoutsApi.status({ sync });
  } catch {
    if (!sync) return null;
    try {
      return await payoutsApi.status();
    } catch {
      return null;
    }
  }
}

/**
 * Asistente de puesta en marcha de la academia.
 *
 * Bloqueante por decisión de producto, pero **solo `nombre` y `marca` son
 * obligatorios**: son los que evitan que un cliente acabe con una academia
 * llamada como su correo y con el aspecto por defecto. Los cuatro pasos
 * restantes se resuelven AQUÍ DENTRO, sin salir: curso y alumnos con su
 * formulario propio, y cobros y correo embebiendo las mismas cards de
 * Configuración (`StripeSettingsCard`, `SmtpSettingsCard`) — mandarlos a otra
 * pestaña rompía el hilo del asistente. Todo lo no obligatorio lleva «Ahora no».
 *
 * En modo plataforma (Didacta Cloud) cambian dos cosas: el paso de cobros
 * embebe la tarjeta «Conectar cobros» (`PaymentsConnectCard`) en vez de la de
 * claves, y el paso de correo no existe — el correo sale de la plataforma. El
 * modo se pregunta durante la carga, así que el rail nunca cambia a la vista.
 *
 * El progreso se guarda en el servidor a cada paso (ver `onboardingApi`), no al
 * final: si se cae la conexión en el paso 5, no se pierden los cuatro anteriores.
 */
/**
 * En las aulas en MODO SENCILLO el asistente es el alta en 3 preguntas; en el
 * resto, el de siempre.
 */
export default function BienvenidaPage() {
  const simple = useSimpleMode();
  if (simple === null) return null;
  return simple ? <AltaOAdopcion /> : <BienvenidaCompleta />;
}

/**
 * Un aula que ya trabajaba (cursos, alumnos o ventas) y pasa al modo sencillo
 * NO hace el alta de cero: el servidor la adopta tal cual y va a «Empieza
 * aquí», que marca lo que ya tiene hecho. Recarga entera para que el gate del
 * aula lea el asistente ya terminado.
 */
function AltaOAdopcion() {
  const router = useRouter();
  const [estado, setEstado] = useState<'comprobando' | 'alta'>('comprobando');
  useEffect(() => {
    // Quien lleva la academia se presenta a sus alumnos ANTES del alta (ver
    // `lib/first-access.ts`). El gate del shell y el login ya mandan al perfil
    // primero; esto cubre a quien abre /welcome directamente.
    if (!authStorage.getSession()?.user.onboardingCompletedAt) {
      router.replace('/onboarding');
      return;
    }
    let vivo = true;
    simpleModeApi
      .adopt()
      .then((r) => {
        if (!vivo) return;
        if (r.adopted) window.location.assign('/start');
        else setEstado('alta');
      })
      .catch(() => vivo && setEstado('alta'));
    return () => {
      vivo = false;
    };
  }, [router]);
  return estado === 'alta' ? <AltaSencilla /> : null;
}

function BienvenidaCompleta() {
  const router = useRouter();
  const t = useTranslations('bienvenida');

  const [cargando, setCargando] = useState(true);
  const [progreso, setProgreso] = useState<OnboardingProgress>(VACIO);
  const [academia, setAcademia] = useState<Academy | null>(null);
  const [theme, setTheme] = useState<TenantTheme | null>(null);
  const [nombre, setNombre] = useState('');
  const [hue, setHue] = useState(213);
  // Saturación de la marca. Las muestras curadas del paso asumen 70; solo se
  // aleja de ahí si el admin pega el hex exacto de su marca.
  const [sat, setSat] = useState(70);
  // Cómo se presenta la marca (solo logo / logo y nombre). Vive aquí y no en
  // PasoMarca porque la cabecera del asistente lo refleja EN VIVO al elegirlo.
  const [modo, setModo] = useState<LogoDisplayMode>('logo_only');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  // «Hecho» local de los pasos que se resuelven en la propia pantalla: decide
  // si el pie ofrece «Continuar» (ya resolvió algo) o «Ahora no» (aún nada).
  // En cobros y correo lo marcan las cards embebidas al guardar — o al cargar,
  // si el tenant ya tenía configuración propia de antes.
  const [cursoHecho, setCursoHecho] = useState(false);
  const [alumnosHecho, setAlumnosHecho] = useState(false);
  const [cobrosHecho, setCobrosHecho] = useState(false);
  const [correoHecho, setCorreoHecho] = useState(false);
  // Referencias estables: son dependencia del efecto de carga de las cards.
  const marcarCobrosHecho = useCallback(() => setCobrosHecho(true), []);
  const marcarCorreoHecho = useCallback(() => setCorreoHecho(true), []);
  // Cobros de plataforma (Didacta Cloud). `null` = asistente de siempre.
  const [cobrosPlataforma, setCobrosPlataforma] = useState<PayoutsStatusDto | null>(null);
  const setup = paymentsSetupOf(cobrosPlataforma);
  const pasos = useMemo(() => onboardingSteps(setup), [setup]);
  const destinosDelModo = useMemo(() => destinos(setup), [setup]);
  const rail = useMemo(() => RAIL.filter((r) => pasos.includes(r.paso)), [pasos]);
  const totalPasos = pasosContables(setup);
  const vistaCobros = derivePayoutsCardView(cobrosPlataforma);

  const paso = progreso.step;
  const indice = pasos.indexOf(paso);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) {
      router.replace('/signin');
      return;
    }
    let cancelado = false;
    void (async () => {
      const lecturaProgreso = onboardingApi.read();
      const [prog, aca, th, cobros] = await Promise.all([
        lecturaProgreso,
        academyApi.getMine(token).catch(() => null),
        themingApi.getMine(token).catch(() => null),
        // Dentro de la carga, no después: los pasos dependen del modo y el
        // rail no debe cambiar a la vista.
        lecturaProgreso.then((p) =>
          p.completedAt ? null : leerCobrosDePlataforma(p.step === 'cobros'),
        ),
      ]);
      if (cancelado) return;
      // Ya lo hizo (o lo hizo el otro admin de la academia): no se repite.
      if (prog.completedAt) {
        router.replace('/home');
        return;
      }
      const setupLeido = paymentsSetupOf(cobros);
      setCobrosPlataforma(setupLeido === 'platform' ? cobros : null);
      if (setupLeido === 'platform' && cobrosConectados(derivePayoutsCardView(cobros))) {
        setCobrosHecho(true);
      }
      // Un `step: 'correo'` guardado no existe en modo plataforma: pasa al
      // siguiente paso válido en vez de dejarlo delante de una pantalla vacía.
      setProgreso(ajustarAlModo(prog, setupLeido));
      setAcademia(aca);
      setTheme(th);
      // El nombre autogenerado NO se precarga: si lo dejamos escrito, basta con
      // darle a continuar para quedarse con «valen.ayesa» sin enterarse.
      setNombre(aca && !aca.looksAutogenerated ? aca.name : '');
      if (th) {
        setHue(th.brandHue);
        setSat(th.brandSaturation);
        setModo(th.logoDisplayMode ?? 'logo_only');
      }
      setCargando(false);
    })();
    return () => {
      cancelado = true;
    };
  }, [router]);

  const persistir = useCallback(async (siguiente: OnboardingProgress) => {
    setProgreso(siguiente);
    try {
      await onboardingApi.write(siguiente);
    } catch {
      // Que no se pueda guardar el progreso no debe cortar el asistente: lo
      // peor que pasa es que al volver empiece antes de donde estaba.
    }
  }, []);

  const irA = useCallback(
    (destino: OnboardingStep, marcar?: { done?: boolean; skipped?: boolean }) => {
      const done = new Set(progreso.done);
      const skipped = new Set(progreso.skipped);
      if (marcar?.done) {
        done.add(paso);
        skipped.delete(paso);
      }
      if (marcar?.skipped) {
        skipped.add(paso);
        done.delete(paso);
      }
      void persistir({
        ...progreso,
        step: destino,
        done: [...done],
        skipped: [...skipped],
      });
      setError(null);
    },
    [paso, progreso, persistir],
  );

  const avanzar = useCallback(
    (marcar?: { done?: boolean; skipped?: boolean }) => {
      const siguiente = pasos[Math.min(indice + 1, pasos.length - 1)]!;
      irA(siguiente, marcar);
    },
    [indice, irA, pasos],
  );

  const retroceder = useCallback(() => {
    irA(pasos[Math.max(indice - 1, 0)]!);
  }, [indice, irA, pasos]);

  const guardarNombre = useCallback(async () => {
    const limpio = nombre.trim();
    if (!limpio) {
      setError(t('nombreVacio'));
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) return;
    setGuardando(true);
    setError(null);
    try {
      const actualizada = await academyApi.rename(token, limpio);
      setAcademia(actualizada);
      avanzar({ done: true });
    } catch {
      setError(t('errorGuardar'));
    } finally {
      setGuardando(false);
    }
  }, [nombre, t, avanzar]);

  const guardarMarca = useCallback(async () => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    setGuardando(true);
    setError(null);
    try {
      const actualizado = await themingApi.update(token, {
        brandHue: hue,
        brandSaturation: sat,
        logoDisplayMode: modo,
      });
      setTheme(actualizado);
      // Aplica el color y el modo de marca en vivo en el resto de la app.
      publishThemeUpdate(actualizado);
      avanzar({ done: true });
    } catch {
      setError(t('errorGuardar'));
    } finally {
      setGuardando(false);
    }
  }, [hue, sat, modo, t, avanzar]);

  const terminar = useCallback(async () => {
    await persistir({ ...progreso, completedAt: new Date().toISOString() });
    // Con el asistente completado el gate ya no redirige: el pase sobra.
    retirarPaseDeBienvenida();
    router.replace('/home');
  }, [progreso, persistir, router]);

  const direccion = useMemo(() => {
    if (academia?.primaryHostname) return `https://${academia.primaryHostname}`;
    if (typeof window !== 'undefined') return window.location.origin;
    return '';
  }, [academia]);

  /**
   * ¿Tiene ya identidad propia? Mientras no la tenga, quien sostiene la
   * pantalla somos nosotros: una academia sin logo y llamada como el correo de
   * su dueño no puede presidir su propio asistente, porque todavía no es nadie.
   * En cuanto pone nombre o logo, el encabezado pasa a ser suyo — y ese cambio
   * a mitad del asistente es justo la recompensa de haberlo rellenado.
   */
  const tieneIdentidad =
    Boolean(theme?.logoUrl) || Boolean(academia && !academia.looksAutogenerated);

  const esObligatorio = PASOS_OBLIGATORIOS.includes(paso);
  const conRail = paso !== 'bienvenida' && paso !== 'resumen';
  const pendientes = pasos.filter((p) => progreso.skipped.includes(p) && destinosDelModo[p]);

  // La cabecera se pinta SIEMPRE — también durante la carga — para que la marca
  // no parpadee al entrar. Durante la carga enseña la de Didacta.
  const cabecera = (
    <header className="mb-6 flex items-center justify-center gap-2.5">
      {!cargando && tieneIdentidad ? (
        <>
          {theme?.logoUrl ? (
            // El logo se pinta a su ANCHO NATURAL (nunca embutido en un
            // cuadrado): un logo horizontal con wordmark quedaba ilegible.
            // En modo «solo el logo» el nombre en texto no se repite.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={theme.logoUrl}
              alt={academia?.name ?? ''}
              className={
                modo === 'logo_only'
                  ? 'h-9 w-auto max-w-[220px] object-contain'
                  : 'h-8 w-auto max-w-[72px] object-contain'
              }
            />
          ) : (
            <div
              className="grid h-8 w-8 place-items-center rounded-lg text-sm font-bold text-white"
              style={{ backgroundColor: `hsl(${hue} ${sat}% 45%)` }}
            >
              {(academia?.name ?? 'A').slice(0, 1).toUpperCase()}
            </div>
          )}
          {(!theme?.logoUrl || modo === 'logo_and_name') && (
            <span className="font-semibold text-night">{academia?.name}</span>
          )}
        </>
      ) : (
        <>
          <Image src="/brand/anagrama.png" alt="" width={26} height={26} priority />
          <span className="font-semibold text-night">Didacta</span>
        </>
      )}
    </header>
  );

  if (cargando) {
    return (
      <>
        {cabecera}
        <Card>
          <CardContent className="space-y-4 p-8">
            <div className="skeleton h-7 w-2/3 rounded-md" />
            <div className="skeleton h-4 w-full rounded-md" />
            <div className="skeleton h-4 w-5/6 rounded-md" />
            <div className="skeleton h-32 w-full rounded-xl" />
            <p className="text-center text-sm text-text-muted">{t('cargando')}</p>
          </CardContent>
        </Card>
      </>
    );
  }

  const railEstado = (p: OnboardingStep): 'hecho' | 'saltado' | 'actual' | 'pendiente' => {
    if (p === paso) return 'actual';
    if (progreso.done.includes(p)) return 'hecho';
    if (progreso.skipped.includes(p)) return 'saltado';
    return 'pendiente';
  };

  return (
    <>
      {/* Animación de entrada de cada paso y aspecto de la barra de color.
          Aquí y no en globals.css porque solo los usa este asistente. */}
      <style>{`
        @keyframes pasoIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: none; }
        }
        .paso-anim { animation: pasoIn 0.3s ease both; }
        @media (prefers-reduced-motion: reduce) {
          .paso-anim { animation: none; }
        }
        .slider-hue {
          -webkit-appearance: none;
          appearance: none;
          height: 12px;
          border-radius: 9999px;
          background: linear-gradient(to right,
            hsl(0 70% 55%), hsl(60 70% 55%), hsl(120 70% 55%),
            hsl(180 70% 55%), hsl(240 70% 55%), hsl(300 70% 55%), hsl(360 70% 55%));
          outline-offset: 4px;
        }
        .slider-hue::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 22px;
          height: 22px;
          border-radius: 9999px;
          background: var(--thumb-color, #333);
          border: 3px solid white;
          box-shadow: 0 1px 4px rgb(0 0 0 / 0.35);
          cursor: pointer;
        }
        .slider-hue::-moz-range-thumb {
          width: 22px;
          height: 22px;
          border-radius: 9999px;
          background: var(--thumb-color, #333);
          border: 3px solid white;
          box-shadow: 0 1px 4px rgb(0 0 0 / 0.35);
          cursor: pointer;
        }
      `}</style>

      {cabecera}

      <Card className="overflow-hidden">
        <div className={conRail ? 'md:grid md:grid-cols-[13rem_1fr]' : undefined}>
          {conRail && (
            <>
              {/* Rail de progreso (escritorio): los 6 pasos, con su estado. */}
              <nav
                aria-label={t('progreso', { actual: indice, total: totalPasos })}
                className="hidden border-r border-border-soft bg-surface-2 p-4 md:block"
              >
                <p className="mb-4 px-2 text-xs font-medium uppercase tracking-wide text-text-subtle">
                  {t('progreso', { actual: indice, total: totalPasos })}
                </p>
                <ol className="space-y-1">
                  {rail.map(({ paso: p, icono, clave }, i) => {
                    const estado = railEstado(p);
                    const visitable = pasos.indexOf(p) < indice;
                    return (
                      <li key={p}>
                        <button
                          type="button"
                          disabled={!visitable || guardando}
                          aria-current={estado === 'actual' ? 'step' : undefined}
                          onClick={() => irA(p)}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
                            estado === 'actual'
                              ? 'bg-brand-100 font-semibold text-brand-800'
                              : visitable
                                ? 'text-text-muted hover:bg-surface-3'
                                : 'text-text-subtle'
                          }`}
                        >
                          <span
                            className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${
                              estado === 'hecho'
                                ? 'bg-success-100 text-success-700'
                                : estado === 'actual'
                                  ? 'bg-brand-500 text-white'
                                  : 'border border-border-strong text-text-subtle'
                            }`}
                          >
                            <Icon name={estado === 'hecho' ? 'check' : icono} size={14} />
                          </span>
                          <span className="truncate">{t(clave as never)}</span>
                          {estado === 'saltado' && (
                            <span className="ml-auto text-xs text-text-subtle">{t('ahoraNo')}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </nav>

              {/* Progreso compacto (móvil): contador + segmentos. */}
              <div className="border-b border-border-soft p-4 md:hidden">
                <p className="mb-2 text-sm text-text-muted">
                  {t('progreso', { actual: indice, total: totalPasos })}
                </p>
                <div className="flex gap-1.5">
                  {rail.map(({ paso: p }) => {
                    const estado = railEstado(p);
                    return (
                      <div
                        key={p}
                        className={`h-1.5 flex-1 rounded-full ${
                          estado === 'hecho' || estado === 'saltado'
                            ? 'bg-brand-500'
                            : estado === 'actual'
                              ? 'bg-brand-300'
                              : 'bg-border'
                        }`}
                      />
                    );
                  })}
                </div>
              </div>
            </>
          )}

          <CardContent className="space-y-6 p-6 sm:p-8">
            <div key={paso} className="paso-anim space-y-6">
              {paso === 'bienvenida' && (
                <div className="space-y-6 py-4 text-center">
                  <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-100 text-brand-700">
                    <Icon name="sparkles" size={28} />
                  </span>
                  <h1 className="font-display text-3xl font-bold tracking-tight">
                    {t('bienvenidaTitulo')}
                  </h1>
                  <p className="mx-auto max-w-lg text-text-muted">{t('bienvenidaCuerpo')}</p>
                  <ul className="mx-auto max-w-sm space-y-2.5 text-left text-sm">
                    {[t('bienvenidaPunto1'), t('bienvenidaPunto2'), t('bienvenidaPunto3')].map(
                      (p) => (
                        <li key={p} className="flex items-start gap-2.5">
                          <span
                            aria-hidden
                            className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-success-100 text-success-700"
                          >
                            <Icon name="check" size={12} />
                          </span>
                          <span>{p}</span>
                        </li>
                      ),
                    )}
                  </ul>
                  <Button size="lg" onClick={() => avanzar()}>
                    {t('bienvenidaEmpezar')}
                  </Button>
                </div>
              )}

              {paso === 'nombre' && (
                <div className="space-y-5">
                  <header className="space-y-1.5">
                    <h1 className="font-display text-2xl font-bold tracking-tight">
                      {t('nombreTitulo')}
                    </h1>
                    <p className="text-text-muted">{t('nombreCuerpo')}</p>
                  </header>
                  {academia?.looksAutogenerated && (
                    <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                      {t('nombreAviso', { nombre: academia.name })}
                    </p>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="nombre-academia">{t('nombreEtiqueta')}</Label>
                    <Input
                      id="nombre-academia"
                      value={nombre}
                      maxLength={120}
                      autoFocus
                      placeholder={t('nombrePlaceholder')}
                      onChange={(e) => setNombre(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void guardarNombre();
                      }}
                    />
                  </div>
                </div>
              )}

              {paso === 'marca' && (
                <PasoMarca
                  academia={academia}
                  theme={theme}
                  hue={hue}
                  onHue={setHue}
                  sat={sat}
                  onSat={setSat}
                  modo={modo}
                  onModo={setModo}
                  onTheme={setTheme}
                />
              )}

              {paso === 'curso' && <PasoCurso onHecho={setCursoHecho} />}

              {paso === 'alumnos' && <PasoAlumnos onHecho={setAlumnosHecho} />}

              {paso === 'cobros' && (
                <div className="space-y-5">
                  <header className="space-y-1.5">
                    <h1 className="font-display text-2xl font-bold tracking-tight">
                      {t('cobrosTitulo')}
                    </h1>
                    <p className="text-text-muted">
                      {setup === 'platform' ? t('cobrosCuerpoConectar') : t('cobrosCuerpo')}
                    </p>
                  </header>
                  {tarjetaDeCobros(setup) === 'conectar' ? (
                    // La misma tarjeta de Administración → Cobros, con el
                    // estado ya leído en la carga (sin segundo «Cargando…»).
                    // Conectar lleva al alta de Stripe; al volver, el estado
                    // se relee con `sync` y, si quedó lista o en revisión, el
                    // pie pasa a «Continuar».
                    <PaymentsConnectCard initialStatus={cobrosPlataforma} />
                  ) : (
                    // La misma card de Configuración → Pagos, embebida: salir
                    // a otra pestaña rompía el hilo del asistente. Al guardar
                    // (o si ya había config propia) marca el paso hecho y el
                    // pie pasa de «Ahora no» a «Continuar».
                    <StripeSettingsCard onSaved={marcarCobrosHecho} />
                  )}
                  {!cobrosHecho && (setup === 'own' || vistaCobros.kind === 'not-connected') && (
                    <Button type="button" variant="outline" onClick={() => avanzar({ done: true })}>
                      {t('cobrosNo')}
                    </Button>
                  )}
                </div>
              )}

              {paso === 'correo' && (
                <div className="space-y-5">
                  <header className="space-y-1.5">
                    <h1 className="font-display text-2xl font-bold tracking-tight">
                      {t('correoTitulo')}
                    </h1>
                    <p className="text-text-muted">{t('correoCuerpo')}</p>
                  </header>
                  <p className="text-sm text-text-muted">{t('correoAyuda')}</p>
                  {/* La card de Configuración → Notificaciones (SMTP), embebida
                      igual que la de cobros. */}
                  <SmtpSettingsCard onSaved={marcarCorreoHecho} />
                </div>
              )}

              {paso === 'resumen' && (
                <div className="space-y-6">
                  <header className="space-y-2 text-center">
                    {theme?.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={theme.logoUrl}
                        alt=""
                        className={
                          modo === 'logo_only'
                            ? 'mx-auto h-14 w-auto max-w-[280px] object-contain'
                            : 'mx-auto h-16 w-auto max-w-[120px] rounded-xl object-contain'
                        }
                      />
                    ) : (
                      <span
                        className="mx-auto grid h-16 w-16 place-items-center rounded-xl text-2xl font-bold text-white"
                        style={{ backgroundColor: `hsl(${hue} ${sat}% 45%)` }}
                      >
                        {(academia?.name ?? 'A').slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <h1 className="font-display text-3xl font-bold tracking-tight">
                      {t('resumenTitulo', { nombre: academia?.name ?? '' })}
                    </h1>
                    <p className="mx-auto max-w-lg text-text-muted">{t('resumenCuerpo')}</p>
                  </header>

                  <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 p-3">
                    <code className="flex-1 truncate text-sm">{direccion}</code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText(direccion);
                        setCopiado(true);
                        window.setTimeout(() => setCopiado(false), 2000);
                      }}
                    >
                      {copiado ? t('resumenDireccionCopiada') : t('resumenDireccionCopiar')}
                    </Button>
                  </div>
                  <p className="text-xs text-text-subtle">{t('resumenDominioPropio')}</p>

                  {pendientes.length === 0 ? (
                    <p className="flex items-center gap-2 rounded-lg bg-success-50 p-3 text-sm text-success-700">
                      <Icon name="check" size={16} />
                      {t('resumenNadaPendiente')}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs uppercase tracking-wide text-text-subtle">
                        {t('resumenPendiente')}
                      </p>
                      <ul className="space-y-2">
                        {pendientes.map((p) => {
                          const item = RAIL.find((r) => r.paso === p);
                          return (
                            <li
                              key={p}
                              className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                            >
                              <span className="flex items-center gap-2 text-sm">
                                {item && (
                                  <Icon name={item.icono} size={16} className="text-text-subtle" />
                                )}
                                {item ? t(item.clave as never) : p}
                              </span>
                              <a
                                className="flex items-center gap-1 text-sm font-semibold text-brand-600 hover:underline"
                                href={destinosDelModo[p]}
                                target="_blank"
                                rel="noopener"
                                onClick={() => concederPaseDeBienvenida()}
                              >
                                {t('resumenAbrir')}
                                <Icon name="arrow-right" size={14} />
                              </a>
                            </li>
                          );
                        })}
                      </ul>
                      <p className="text-xs text-text-subtle">{t('resumenPendienteAyuda')}</p>
                    </div>
                  )}

                  <Button size="lg" className="w-full" onClick={() => void terminar()}>
                    {t('resumenEntrar')}
                  </Button>
                </div>
              )}

              {error && (
                <p role="alert" className="flex items-start gap-1.5 text-sm text-danger-700">
                  <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
                  {error}
                </p>
              )}
            </div>

            {/* Pie de navegación. En «bienvenida» y «resumen» el botón va arriba. */}
            {conRail && (
              <div className="flex items-center justify-between gap-3 border-t border-border-soft pt-4">
                <Button variant="ghost" onClick={retroceder} disabled={guardando}>
                  {t('atras')}
                </Button>
                <div className="flex items-center gap-2">
                  {/* Pasos saltables (curso/alumnos/cobros/correo): mientras no
                      hayan resuelto nada, la única salida hacia delante es
                      «Ahora no» — el pie nunca ofrece un «Continuar» que dé
                      por hecho lo que no se hizo. En cuanto resuelven (curso
                      creado, invitación enviada, pestaña abierta), aparece. */}
                  {paso === 'curso' ||
                  paso === 'alumnos' ||
                  paso === 'cobros' ||
                  paso === 'correo' ? (
                    (
                      paso === 'curso'
                        ? cursoHecho
                        : paso === 'alumnos'
                          ? alumnosHecho
                          : paso === 'cobros'
                            ? cobrosHecho
                            : correoHecho
                    ) ? (
                      <Button onClick={() => avanzar({ done: true })} disabled={guardando}>
                        {t('siguiente')}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => avanzar({ skipped: true })}
                        disabled={guardando}
                      >
                        {t('ahoraNo')}
                      </Button>
                    )
                  ) : (
                    <>
                      {!esObligatorio && (
                        <Button
                          variant="ghost"
                          onClick={() => avanzar({ skipped: true })}
                          disabled={guardando}
                        >
                          {t('ahoraNo')}
                        </Button>
                      )}
                      {(paso === 'nombre' || paso === 'marca') && (
                        <Button
                          onClick={() => {
                            if (paso === 'nombre') return void guardarNombre();
                            return void guardarMarca();
                          }}
                          disabled={guardando}
                        >
                          {guardando ? t('guardando') : t('siguiente')}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </div>
      </Card>
    </>
  );
}
