'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '@/components/icon';
import {
  RequestPerkModal,
  SubmitChallengeModal,
  gamificationApi,
  type ChallengeView,
  type LevelView,
  type MyPerkView,
  type Standing,
} from '@/modules/gamification';

/// Retos y puntos (vista del miembro). La pantalla se lee de arriba abajo como
/// una respuesta a "¿y esto para qué me sirve?": qué te falta para el siguiente
/// nivel → qué niveles hay → qué abre cada uno → qué puedes entregar hoy.
///
/// Todo lo que se pinta sale de la API de mod.gamification. Lo que no está en la
/// BD no se inventa: por eso no hay duración estimada por reto, ni contadores de
/// entregas de la comunidad (requieren campo/endpoint nuevos).

const STATUS_LABEL: Record<string, { label: string; tone: 'info' | 'ok' | 'off' }> = {
  PENDING: { label: 'En revisión', tone: 'info' },
  APPROVED: { label: 'Aprobado', tone: 'ok' },
  REJECTED: { label: 'No aprobado', tone: 'off' },
};

const REQUEST_LABEL: Record<string, string> = {
  PENDING: 'Solicitado',
  APPROVED: 'Aprobado',
  DONE: 'Hecho',
  REJECTED: 'No concedido',
};

/**
 * Iconos de los beneficios. NO es un dato del beneficio (la tabla no tiene
 * icono): es decoración estable — el mismo beneficio cae siempre en el mismo
 * icono porque el orden de la lista lo fija el servidor.
 */
const PERK_ICONS: IconName[] = ['message', 'file', 'users', 'award'];

export default function RetosPage() {
  const [challenges, setChallenges] = useState<ChallengeView[]>([]);
  const [levels, setLevels] = useState<LevelView[]>([]);
  const [perks, setPerks] = useState<MyPerkView[]>([]);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, levelList, mine, myPerks] = await Promise.all([
        gamificationApi.listChallenges(),
        gamificationApi.listLevels(),
        gamificationApi.myStanding('all'),
        gamificationApi.myPerks(),
      ]);
      setChallenges(list);
      setLevels(levelList);
      setStanding(mine);
      setPerks(myPerks);
    } catch {
      setError('No se pudieron cargar los retos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const points = standing?.lifetimePoints ?? 0;
  const ordered = useMemo(() => [...levels].sort((a, b) => a.minPoints - b.minPoints), [levels]);
  /**
   * Beneficios de menos a más caro. El servidor los devuelve por fecha de alta,
   * que en pantalla se lee raro: la rejilla tiene que subir igual que la
   * escalera, del que casi tienes al que queda lejos.
   */
  const perksPorNivel = useMemo(
    () => [...perks].sort((a, b) => a.levelMinPoints - b.levelMinPoints),
    [perks],
  );
  const nextLevel = ordered.find((l) => l.minPoints > points) ?? null;
  const currentLevel = [...ordered].reverse().find((l) => l.minPoints <= points) ?? null;
  const gap = nextLevel ? nextLevel.minPoints - points : 0;

  /** Retos que aún puedes entregar (los ya entregados no suman de nuevo). */
  const pendientes = useMemo(() => challenges.filter((c) => !c.mySubmission), [challenges]);
  /** El más barato que te llevaría al siguiente nivel; si ninguno llega, el más barato. */
  const atajo = useMemo(() => {
    if (pendientes.length === 0) return null;
    const porPuntos = [...pendientes].sort((a, b) => a.points - b.points);
    return porPuntos.find((c) => c.points >= gap) ?? porPuntos[0]!;
  }, [pendientes, gap]);

  return (
    <div className="space-y-8">
      <h1 className="sr-only">Retos</h1>

      <Hero
        standing={standing}
        currentLevel={currentLevel}
        nextLevel={nextLevel}
        gap={gap}
        atajo={atajo}
        siguienteBeneficio={perks.find((p) => p.levelId === nextLevel?.id)?.title ?? null}
        retosAbiertos={pendientes.length}
        puntosDisponibles={pendientes.reduce((sum, c) => sum + c.points, 0)}
        onSubmitted={load}
      />

      {ordered.length > 0 ? (
        <Section
          title="Tu escalera"
          note="Cada nivel abre algo concreto. Nada caduca: los puntos se acumulan."
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {ordered.map((level) => (
              <LevelCard
                key={level.id}
                level={level}
                points={points}
                isNext={nextLevel?.id === level.id}
                perks={perks.filter((p) => p.levelId === level.id)}
              />
            ))}
          </div>
        </Section>
      ) : null}

      {perks.length > 0 ? (
        <Section
          title="En qué puedes gastar tus puntos"
          note="Los puntos no se gastan: al alcanzar el nivel, la ventaja queda abierta."
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {perksPorNivel.map((perk, i) => (
              <PerkCard
                key={perk.id}
                perk={perk}
                icon={PERK_ICONS[i % PERK_ICONS.length]!}
                // Solo el beneficio que tienes A TIRO lleva la cuenta atrás; los
                // de más arriba dicen "Bloqueado" y no marean con cifras lejanas.
                puntosQueFaltan={
                  perk.levelId === nextLevel?.id ? Math.max(0, perk.levelMinPoints - points) : null
                }
                onDone={load}
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Retos abiertos" note="Las entregas las revisa el equipo.">
        {loading ? (
          <p className="text-sm text-text-muted">Cargando retos…</p>
        ) : error ? (
          <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-muted">
            {error}
          </div>
        ) : challenges.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-12 text-center">
            <p className="text-base font-semibold text-text">Todavía no hay retos abiertos</p>
            <p className="mt-1 text-sm text-text-muted">
              Cuando el equipo publique uno, aparecerá aquí con su premio en puntos.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            {challenges.map((challenge) => (
              <ChallengeCard key={challenge.id} challenge={challenge} onDone={load} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ───────────────────────── cabecera ─────────────────────────

function Hero({
  standing,
  currentLevel,
  nextLevel,
  gap,
  atajo,
  siguienteBeneficio,
  retosAbiertos,
  puntosDisponibles,
  onSubmitted,
}: {
  standing: Standing | null;
  currentLevel: LevelView | null;
  nextLevel: LevelView | null;
  gap: number;
  atajo: ChallengeView | null;
  /** Título del primer beneficio que abre el siguiente nivel, si lo hay. */
  siguienteBeneficio: string | null;
  retosAbiertos: number;
  puntosDisponibles: number;
  onSubmitted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (!standing) return null;

  const points = standing.lifetimePoints;
  const desde = currentLevel?.minPoints ?? 0;
  const tramo = nextLevel ? Math.max(1, nextLevel.minPoints - desde) : 1;
  const progreso = nextLevel ? Math.min(100, Math.round(((points - desde) / tramo) * 100)) : 100;
  // "Muy cerca" = ya has recorrido el 80% del tramo hasta el siguiente nivel.
  const muyCerca = nextLevel !== null && progreso >= 80;

  return (
    <section className="overflow-hidden rounded-2xl bg-(--didacta-night) text-white">
      <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_minmax(0,26rem)]">
        <div className="min-w-0">
          {muyCerca ? (
            <span className="inline-flex rounded-full bg-(--didacta-growth)/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-(--didacta-growth)">
              Estás muy cerca
            </span>
          ) : null}

          {/* text-white explícito: el `h2` global trae su propio color y ganaría
              al `text-white` heredado de la sección. */}
          <h2 className="mt-3 font-display text-3xl font-bold leading-tight text-white">
            {nextLevel
              ? `Te faltan ${gap.toLocaleString('es-ES')} ${gap === 1 ? 'punto' : 'puntos'} para ser ${nextLevel.name}`
              : currentLevel
                ? `Estás en ${currentLevel.name}, el nivel más alto`
                : 'Empieza a sumar puntos'}
          </h2>

          <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/70">
            {atajo ? (
              <>
                Con el reto de <span className="text-white">{lowerFirst(atajo.title)}</span> ya
                tienes {atajo.points} puntos.
              </>
            ) : (
              'Ahora mismo no tienes retos pendientes de entregar.'
            )}{' '}
            {/* Lo que se abre arriba: mejor el beneficio concreto que la
                descripción del nivel — es lo que de verdad mueve a entregar. */}
            {siguienteBeneficio
              ? `Al llegar a ${nextLevel!.name} se abre: ${siguienteBeneficio}.`
              : nextLevel?.benefitText
                ? `Al llegar a ${nextLevel.name}: ${lowerFirst(nextLevel.benefitText)}`
                : null}
          </p>

          {atajo ? (
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-(--didacta-night) transition-opacity hover:opacity-90"
              >
                <Icon name="arrow-right" size={15} />
                Entregar el reto más rápido
              </button>
              <p className="text-sm text-white/60">
                {atajo.title} · +{atajo.points} puntos
              </p>
              <SubmitChallengeModal
                challenge={atajo}
                open={open}
                onOpenChange={setOpen}
                onSubmitted={onSubmitted}
              />
            </div>
          ) : null}
        </div>

        {/* Panel de cifras: todo sale de /me y de los retos abiertos. */}
        <div className="rounded-xl bg-white/5 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
                Puntos acumulados
              </p>
              <p className="font-display text-4xl font-bold leading-none">
                {points.toLocaleString('es-ES')}
              </p>
            </div>
            {nextLevel ? (
              <div className="text-right">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
                  Siguiente nivel
                </p>
                <p className="font-semibold text-(--didacta-growth)">
                  {nextLevel.name} · {nextLevel.minPoints.toLocaleString('es-ES')}
                </p>
              </div>
            ) : null}
          </div>

          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-(--didacta-growth)"
              style={{ width: `${progreso}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-white/50">
            <span>{currentLevel?.name ?? 'Sin nivel todavía'}</span>
            {nextLevel ? (
              <span>
                {gap.toLocaleString('es-ES')} {gap === 1 ? 'punto' : 'puntos'} para {nextLevel.name}
              </span>
            ) : null}
          </div>

          <dl className="mt-5 grid grid-cols-3 gap-4 border-t border-white/10 pt-4">
            <Cifra label="Retos abiertos" valor={retosAbiertos.toLocaleString('es-ES')} />
            <Cifra label="Puntos disponibles" valor={puntosDisponibles.toLocaleString('es-ES')} />
            <Cifra
              label="Tu puesto"
              valor={standing.rank ? `${standing.rank} de ${standing.total}` : '—'}
            />
          </dl>
        </div>
      </div>
    </section>
  );
}

function Cifra({ label, valor }: { label: string; valor: string }) {
  return (
    <div>
      <dt className="text-[11px] text-white/50">{label}</dt>
      <dd className="mt-0.5 font-semibold">{valor}</dd>
    </div>
  );
}

// ───────────────────────── secciones ─────────────────────────

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-bold text-text">{title}</h2>
        <p className="text-xs text-text-muted">{note}</p>
      </div>
      {children}
    </section>
  );
}

function Chip({
  children,
  tone = 'off',
}: {
  children: React.ReactNode;
  tone?: 'ok' | 'info' | 'off';
}) {
  const tones = {
    ok: 'bg-(--didacta-success-bg) text-(--didacta-success-fg)',
    info: 'bg-(--didacta-info-bg) text-(--didacta-info-fg)',
    off: 'bg-bg-subtle text-text-muted',
  } as const;
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// ───────────────────────── escalera ─────────────────────────

function LevelCard({
  level,
  points,
  isNext,
  perks,
}: {
  level: LevelView;
  points: number;
  isNext: boolean;
  perks: MyPerkView[];
}) {
  const alcanzado = points >= level.minPoints;
  const faltan = Math.max(0, level.minPoints - points);

  return (
    <article
      className={`flex flex-col rounded-xl border p-5 ${
        isNext ? 'border-(--didacta-growth) bg-surface' : 'border-border bg-surface'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        {alcanzado ? (
          <Chip tone="ok">Alcanzado</Chip>
        ) : isNext ? (
          <Chip tone="ok">A {faltan.toLocaleString('es-ES')} puntos</Chip>
        ) : (
          <Chip>Bloqueado</Chip>
        )}
        <span className="text-xs text-text-muted">
          Desde {level.minPoints.toLocaleString('es-ES')}
        </span>
      </div>

      {isNext ? (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-bg-subtle">
          <div
            className="h-full rounded-full bg-(--didacta-growth)"
            style={{ width: `${Math.min(100, Math.round((points / level.minPoints) * 100))}%` }}
          />
        </div>
      ) : (
        <div className="mt-3 h-1 rounded-full bg-bg-subtle" />
      )}

      <h3 className="mt-3 font-display text-lg font-bold text-text">{level.name}</h3>
      {level.benefitText ? (
        <p className="mt-1 text-sm text-text-muted">{level.benefitText}</p>
      ) : null}

      {perks.length > 0 ? (
        <div className="mt-4 space-y-3 border-t border-border pt-3">
          {perks.map((perk) => (
            <div key={perk.id}>
              <p className="flex items-start gap-1.5 text-sm font-semibold text-text">
                <Icon name={alcanzado ? 'check' : 'lock'} size={13} className="mt-0.5 shrink-0" />
                {perk.title}
              </p>
              {perk.description ? (
                <p className="mt-0.5 pl-5 text-xs text-text-muted">{perk.description}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

// ───────────────────────── beneficios ─────────────────────────

/** "Una cada 30 días", "Acceso permanente", "Sin límite"… con datos del beneficio. */
function limiteTexto(perk: MyPerkView): string {
  const { maxPerUser, cooldownDays } = perk;
  if (cooldownDays > 0 && maxPerUser > 0) {
    return `${maxPerUser} en total, una cada ${cooldownDays} días`;
  }
  if (cooldownDays > 0) return `Una cada ${cooldownDays} días`;
  if (maxPerUser === 1) return 'Una sola vez';
  if (maxPerUser > 1) return `Hasta ${maxPerUser} veces`;
  return 'Sin límite de solicitudes';
}

function PerkCard({
  perk,
  icon,
  puntosQueFaltan,
  onDone,
}: {
  perk: MyPerkView;
  icon: IconName;
  /** null si el nivel que lo abre no es el siguiente: entonces va "Bloqueado". */
  puntosQueFaltan: number | null;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <article
      className={`flex flex-col rounded-xl border p-5 ${
        perk.unlocked ? 'border-(--didacta-growth) bg-surface' : 'border-border bg-surface'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={`grid h-9 w-9 place-items-center rounded-lg ${
            perk.unlocked
              ? 'bg-(--didacta-success-bg) text-(--didacta-success-fg)'
              : 'bg-bg-subtle text-text-muted'
          }`}
        >
          <Icon name={icon} size={16} />
        </span>
        {perk.lastRequestStatus ? (
          <Chip tone="info">{REQUEST_LABEL[perk.lastRequestStatus]}</Chip>
        ) : perk.unlocked ? (
          <Chip tone="ok">Disponible</Chip>
        ) : puntosQueFaltan !== null ? (
          <Chip tone="ok">A {puntosQueFaltan.toLocaleString('es-ES')} puntos</Chip>
        ) : (
          <Chip>Bloqueado</Chip>
        )}
      </div>

      <h3 className="mt-3 font-display text-base font-bold leading-snug text-text">{perk.title}</h3>
      {perk.description ? (
        <p className="mt-1.5 whitespace-pre-line text-sm text-text-muted">{perk.description}</p>
      ) : null}

      <div className="mt-4 space-y-1 border-t border-border pt-3 text-xs">
        <p className="font-semibold text-text">{limiteTexto(perk)}</p>
        <p className="text-text-muted">
          {perk.unlocked
            ? `Desbloqueado con ${perk.levelName}`
            : `Se desbloquea en ${perk.levelName} · ${perk.levelMinPoints.toLocaleString('es-ES')} puntos`}
        </p>
      </div>

      {perk.unlocked ? (
        <div className="mt-4">
          {perk.canRequest ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="rounded-lg bg-(--didacta-trust) px-3 py-1.5 text-sm font-medium text-white"
            >
              Pedirlo
            </button>
          ) : perk.availableAt ? (
            <p className="text-xs text-text-muted">
              Podrás volver a pedirlo el {new Date(perk.availableAt).toLocaleDateString('es-ES')}.
            </p>
          ) : (
            <p className="text-xs text-text-muted">Ya lo has aprovechado.</p>
          )}
        </div>
      ) : null}

      <RequestPerkModal perk={perk} open={open} onOpenChange={setOpen} onRequested={onDone} />
    </article>
  );
}

// ───────────────────────── retos ─────────────────────────

function ChallengeCard({
  challenge,
  onDone,
}: {
  challenge: ChallengeView;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const submitted = challenge.mySubmission;
  const estado = submitted ? STATUS_LABEL[submitted.status] : null;

  return (
    <article
      data-testid="challenge-card"
      className="flex flex-col rounded-xl border border-border bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {challenge.proofRequired ? <Chip tone="info">Con prueba</Chip> : null}
          {estado ? <Chip tone={estado.tone}>{estado.label}</Chip> : null}
        </div>
        <p className="shrink-0 text-right">
          <span className="font-display text-2xl font-bold text-(--didacta-growth)">
            +{challenge.points}
          </span>
          <span className="block text-[11px] text-text-muted">puntos</span>
        </p>
      </div>

      <h3 className="mt-3 font-display text-lg font-bold leading-snug text-text">
        {challenge.title}
      </h3>
      {challenge.description ? (
        <p className="mt-1.5 whitespace-pre-line text-sm text-text-muted">
          {challenge.description}
        </p>
      ) : null}

      {submitted?.reviewNote ? (
        <p className="mt-3 rounded-lg bg-bg-subtle px-3 py-2 text-sm text-text-muted">
          <span className="font-medium text-text">Respuesta del equipo:</span>{' '}
          {submitted.reviewNote}
        </p>
      ) : null}

      {!submitted ? (
        <div className="mt-4 flex justify-end border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg bg-(--didacta-trust) px-4 py-2 text-sm font-medium text-white"
          >
            Entregar
          </button>
        </div>
      ) : null}

      <SubmitChallengeModal
        challenge={challenge}
        open={open}
        onOpenChange={setOpen}
        onSubmitted={onDone}
      />
    </article>
  );
}

/** "Puedes proponer…" → "puedes proponer…" para encadenarlo en una frase. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
