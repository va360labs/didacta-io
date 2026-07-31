'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { UserChip } from '@/components/user-chip';
import { ApiHttpError } from '@/lib/api-client';
import {
  gamificationAdminApi,
  gamificationApi,
  type ChallengeView,
  type LevelView,
  type PerkRequestView,
  type PerkView,
  type RuleView,
  type SubmissionView,
} from '@/modules/gamification';

/// Panel de mod.gamification (bloque 1). Todo el catálogo lo define el operador:
/// las reglas se siembran con los pesos del ranking anterior, y los NIVELES y
/// los RETOS nacen vacíos a propósito — sus nombres y premios son decisiones de
/// marca, no datos que pueda inventar el sistema.

/** Etiquetas legibles de las reglas automáticas. */
const RULE_LABELS: Record<string, string> = {
  'community.post': 'Publicar un post',
  'community.comment': 'Responder a alguien',
  'resources.shared': 'Compartir un recurso',
  'learning.course': 'Terminar un curso',
  'referrals.converted': 'Traer a un referido',
};

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiHttpError || e instanceof Error ? e.message : fallback;
}

export default function AdminGamificacionPage() {
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">Puntos y retos</h1>
        <p className="mt-1 text-sm text-text-muted">
          Define cuánto vale cada cosa, qué niveles hay y qué retos están abiertos.
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-(--didacta-coral)/40 bg-(--didacta-coral)/5 p-4 text-sm text-text">
          {error}
        </div>
      ) : null}

      <Tabs defaultValue="retos">
        <TabsList>
          <TabsTrigger value="retos">Retos</TabsTrigger>
          <TabsTrigger value="entregas">Entregas</TabsTrigger>
          <TabsTrigger value="niveles">Niveles</TabsTrigger>
          <TabsTrigger value="beneficios">Beneficios</TabsTrigger>
          <TabsTrigger value="solicitudes">Solicitudes</TabsTrigger>
          <TabsTrigger value="reglas">Reglas</TabsTrigger>
        </TabsList>

        <TabsContent value="retos">
          <ChallengesPanel onError={setError} />
        </TabsContent>
        <TabsContent value="entregas">
          <SubmissionsPanel onError={setError} />
        </TabsContent>
        <TabsContent value="niveles">
          <LevelsPanel onError={setError} />
        </TabsContent>
        <TabsContent value="beneficios">
          <PerksPanel onError={setError} />
        </TabsContent>
        <TabsContent value="solicitudes">
          <PerkRequestsPanel onError={setError} />
        </TabsContent>
        <TabsContent value="reglas">
          <RulesPanel onError={setError} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Retos ────────────────────────────────────────────────────────────────────

function ChallengesPanel({ onError }: { onError: (m: string | null) => void }) {
  const [challenges, setChallenges] = useState<ChallengeView[] | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [points, setPoints] = useState('100');
  const [proofRequired, setProofRequired] = useState(true);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setChallenges(await gamificationAdminApi.listChallenges());
  }, []);

  useEffect(() => {
    reload().catch((e) => onError(errorMessage(e, 'No pudimos cargar los retos.')));
  }, [reload, onError]);

  async function create() {
    setBusy(true);
    onError(null);
    try {
      await gamificationAdminApi.createChallenge({
        title,
        description: description.trim() || undefined,
        points: Number(points),
        proofRequired,
      });
      setTitle('');
      setDescription('');
      setPoints('100');
      await reload();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos crear el reto.'));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(challenge: ChallengeView, status: ChallengeView['status']) {
    onError(null);
    try {
      await gamificationAdminApi.updateChallenge(challenge.id, { status });
      await reload();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos cambiar el estado del reto.'));
    }
  }

  async function remove(challenge: ChallengeView) {
    onError(null);
    try {
      await gamificationAdminApi.deleteChallenge(challenge.id);
      await reload();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos borrar el reto.'));
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Nuevo reto</CardTitle>
          <CardDescription>
            Nace en borrador. Ábrelo cuando quieras que la comunidad lo vea.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <div className="space-y-1.5">
              <Label htmlFor="reto-titulo">Título</Label>
              <Input
                id="reto-titulo"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Publica tu caso de éxito"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reto-puntos">Puntos</Label>
              <Input
                id="reto-puntos"
                type="number"
                min={1}
                value={points}
                onChange={(e) => setPoints(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reto-desc">Qué hay que hacer</Label>
            <Textarea
              id="reto-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Explica el reto y qué prueba esperas recibir."
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={proofRequired}
              onChange={(e) => setProofRequired(e.target.checked)}
            />
            Exigir prueba (captura, archivo o enlace) para poder entregar
          </label>
          <Button onClick={() => void create()} disabled={busy || title.trim().length < 3}>
            {busy ? 'Creando…' : 'Crear reto'}
          </Button>
        </CardContent>
      </Card>

      {challenges === null ? (
        <p className="text-sm text-text-muted">Cargando retos…</p>
      ) : challenges.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">Todavía no has creado ningún reto</p>
            <p className="mt-1 text-sm text-text-muted">
              El primero que suele funcionar: pedir que documenten y publiquen su caso de éxito.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {challenges.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-text">{c.title}</p>
                    <Badge variant={c.status === 'OPEN' ? 'success' : 'muted'}>
                      {c.status === 'OPEN'
                        ? 'Abierto'
                        : c.status === 'DRAFT'
                          ? 'Borrador'
                          : 'Cerrado'}
                    </Badge>
                    <Badge variant="info">+{c.points} puntos</Badge>
                    {c.proofRequired ? <Badge variant="muted">Con prueba</Badge> : null}
                  </div>
                  {c.description ? (
                    <p className="mt-1 text-sm text-text-muted">{c.description}</p>
                  ) : null}
                  <p className="mt-1 text-xs text-text-muted">
                    {c.submissionCount ?? 0} entrega(s)
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {c.status !== 'OPEN' ? (
                    <Button size="sm" onClick={() => void setStatus(c, 'OPEN')}>
                      Abrir
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => void setStatus(c, 'CLOSED')}>
                      Cerrar
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void remove(c)}>
                    Borrar
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Entregas ─────────────────────────────────────────────────────────────────

function SubmissionsPanel({ onError }: { onError: (m: string | null) => void }) {
  const [submissions, setSubmissions] = useState<SubmissionView[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [soloPendientes, setSoloPendientes] = useState(true);

  // Todas de una vez: revisar una entrega no puede hacerla desaparecer sin
  // dejar rastro de qué se aprobó y qué se rechazó.
  const reload = useCallback(async () => {
    setSubmissions(await gamificationAdminApi.listSubmissions());
  }, []);

  useEffect(() => {
    reload().catch((e) => onError(errorMessage(e, 'No pudimos cargar las entregas.')));
  }, [reload, onError]);

  async function review(submission: SubmissionView, approve: boolean) {
    onError(null);
    try {
      const note = notes[submission.id]?.trim();
      await gamificationAdminApi.review(submission.id, {
        approve,
        ...(note ? { reviewNote: note } : {}),
      });
      await reload();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos registrar la revisión.'));
    }
  }

  const todas = submissions ?? [];
  const pendientes = todas.filter((s) => s.status === 'PENDING');
  const visibles = soloPendientes ? pendientes : todas;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSoloPendientes(true)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            soloPendientes
              ? 'border-(--didacta-trust) bg-(--didacta-trust)/10 text-(--didacta-trust)'
              : 'border-border text-text-muted hover:text-text'
          }`}
        >
          Por revisar{pendientes.length > 0 ? ` (${pendientes.length})` : ''}
        </button>
        <button
          type="button"
          onClick={() => setSoloPendientes(false)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            !soloPendientes
              ? 'border-(--didacta-trust) bg-(--didacta-trust)/10 text-(--didacta-trust)'
              : 'border-border text-text-muted hover:text-text'
          }`}
        >
          Todas{todas.length > 0 ? ` (${todas.length})` : ''}
        </button>
      </div>

      {submissions === null ? (
        <p className="text-sm text-text-muted">Cargando entregas…</p>
      ) : visibles.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">
              {soloPendientes ? 'No hay entregas por revisar' : 'Todavía no hay entregas'}
            </p>
            <p className="mt-1 text-sm text-text-muted">
              Aquí aparecen las entregas en cuanto alguien completa un reto.
            </p>
          </CardContent>
        </Card>
      ) : (
        visibles.map((s) => (
          <Card key={s.id}>
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-text">{s.challengeTitle}</p>
                  <div className="flex items-center gap-1.5 text-sm text-text-muted">
                    <UserChip
                      userId={s.userId}
                      name={s.displayName}
                      fallback="Alumno"
                      showAvatar={false}
                      size={20}
                      nameClassName="block truncate text-sm text-text-muted"
                    />
                    <span>· {new Date(s.createdAt).toLocaleDateString('es-ES')}</span>
                  </div>
                </div>
                {s.status !== 'PENDING' ? (
                  <Badge variant={s.status === 'APPROVED' ? 'success' : 'muted'}>
                    {s.status === 'APPROVED' ? 'Aprobada' : 'Rechazada'}
                  </Badge>
                ) : null}
                {s.proofUrl ? (
                  <a
                    href={s.proofUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sm font-medium text-(--didacta-trust) underline"
                  >
                    Ver prueba{s.proofName ? ` (${s.proofName})` : ''}
                  </a>
                ) : (
                  <span className="text-sm text-text-muted">Sin prueba adjunta</span>
                )}
              </div>

              {s.note ? (
                <p className="whitespace-pre-line rounded-lg bg-bg-subtle px-3 py-2 text-sm text-text-muted">
                  {s.note}
                </p>
              ) : null}

              {s.reviewNote ? (
                <p className="whitespace-pre-line text-sm text-text-muted">
                  <span className="font-medium text-text">Tu comentario:</span> {s.reviewNote}
                </p>
              ) : null}

              {s.status === 'PENDING' ? (
                <>
                  <Textarea
                    rows={2}
                    placeholder="Comentario para quien entrega (opcional)"
                    value={notes[s.id] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [s.id]: e.target.value }))}
                  />

                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void review(s, true)}>
                      Aprobar y dar puntos
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void review(s, false)}>
                      Rechazar
                    </Button>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ── Niveles ──────────────────────────────────────────────────────────────────

function LevelsPanel({ onError }: { onError: (m: string | null) => void }) {
  const [levels, setLevels] = useState<LevelView[] | null>(null);
  const [name, setName] = useState('');
  const [minPoints, setMinPoints] = useState('100');
  const [benefitText, setBenefitText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLevels(await gamificationApi.listLevels());
  }, []);

  useEffect(() => {
    load().catch((e) => onError(errorMessage(e, 'No pudimos cargar los niveles.')));
  }, [load, onError]);

  async function create() {
    setBusy(true);
    onError(null);
    try {
      await gamificationAdminApi.createLevel({
        key: slugify(name),
        name,
        minPoints: Number(minPoints),
        benefitText: benefitText.trim() || undefined,
      });
      setName('');
      setMinPoints('100');
      setBenefitText('');
      await load();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos crear el nivel.'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(level: LevelView) {
    onError(null);
    try {
      await gamificationAdminApi.deleteLevel(level.id);
      await load();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos borrar el nivel.'));
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Nuevo nivel</CardTitle>
          <CardDescription>
            El nivel se alcanza con los puntos acumulados de por vida, que nunca se reinician.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <div className="space-y-1.5">
              <Label htmlFor="nivel-nombre">Nombre</Label>
              <Input
                id="nivel-nombre"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Cómo quieres llamarlo"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nivel-puntos">Desde (puntos)</Label>
              <Input
                id="nivel-puntos"
                type="number"
                min={0}
                value={minPoints}
                onChange={(e) => setMinPoints(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nivel-beneficio">Beneficio</Label>
            <Textarea
              id="nivel-beneficio"
              rows={2}
              value={benefitText}
              onChange={(e) => setBenefitText(e.target.value)}
              placeholder="Qué se lleva quien llega hasta aquí."
            />
          </div>
          <Button onClick={() => void create()} disabled={busy || name.trim().length < 2}>
            {busy ? 'Creando…' : 'Crear nivel'}
          </Button>
        </CardContent>
      </Card>

      {levels === null ? (
        <p className="text-sm text-text-muted">Cargando niveles…</p>
      ) : levels.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">Todavía no has definido ningún nivel</p>
            <p className="mt-1 text-sm text-text-muted">
              Hasta que crees el primero, nadie tiene nivel: los puntos se acumulan igual.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {levels.map((l) => (
            <Card key={l.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <p className="font-semibold text-text">{l.name}</p>
                  <p className="text-xs text-text-muted">
                    Desde {l.minPoints.toLocaleString('es-ES')} puntos
                  </p>
                  {l.benefitText ? (
                    <p className="mt-1 text-sm text-text-muted">{l.benefitText}</p>
                  ) : null}
                </div>
                <Button variant="ghost" size="sm" onClick={() => void remove(l)}>
                  Borrar
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function slugify(value: string): string {
  return (
    value
      .normalize('NFD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'nivel'
  );
}

// ── Beneficios ───────────────────────────────────────────────────────────────

function PerksPanel({ onError }: { onError: (m: string | null) => void }) {
  const [perks, setPerks] = useState<PerkView[] | null>(null);
  const [levels, setLevels] = useState<LevelView[]>([]);
  const [levelId, setLevelId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [maxPerUser, setMaxPerUser] = useState('1');
  const [cooldownDays, setCooldownDays] = useState('0');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, levelList] = await Promise.all([
      gamificationAdminApi.listPerks(),
      gamificationApi.listLevels(),
    ]);
    setPerks(list);
    setLevels(levelList);
    setLevelId((prev) => prev || (levelList[0]?.id ?? ''));
  }, []);

  useEffect(() => {
    load().catch((e) => onError(errorMessage(e, 'No pudimos cargar los beneficios.')));
  }, [load, onError]);

  async function create() {
    setBusy(true);
    onError(null);
    try {
      await gamificationAdminApi.createPerk({
        levelId,
        title,
        description: description.trim() || undefined,
        maxPerUser: Number(maxPerUser),
        cooldownDays: Number(cooldownDays),
      });
      setTitle('');
      setDescription('');
      await load();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos crear el beneficio.'));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(perk: PerkView) {
    onError(null);
    try {
      await gamificationAdminApi.updatePerk(perk.id, { active: !perk.active });
      await load();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos cambiar el beneficio.'));
    }
  }

  async function remove(perk: PerkView) {
    onError(null);
    try {
      await gamificationAdminApi.deletePerk(perk.id);
      await load();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos borrar el beneficio.'));
    }
  }

  if (levels.length === 0) {
    return (
      <Card className="mt-4">
        <CardContent className="py-10 text-center">
          <p className="font-semibold text-text">Primero crea un nivel</p>
          <p className="mt-1 text-sm text-text-muted">
            Un beneficio cuelga de un nivel: es lo que hay que alcanzar para desbloquearlo.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Nuevo beneficio</CardTitle>
          <CardDescription>
            Lo que desbloquea un nivel: una sesión 1:1, una clase extra, una píldora a medida… No se
            concede solo — el alumno lo pide y tú lo atiendes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
            <div className="space-y-1.5">
              <Label htmlFor="perk-titulo">Qué desbloquea</Label>
              <Input
                id="perk-titulo"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Sesión 1:1 de 30 minutos conmigo"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perk-nivel">Nivel que lo desbloquea</Label>
              <select
                id="perk-nivel"
                value={levelId}
                onChange={(e) => setLevelId(e.target.value)}
                className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text"
              >
                {levels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.minPoints} pts)
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="perk-desc">Detalle para el alumno</Label>
            <Textarea
              id="perk-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Qué incluye y cómo se organiza."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="perk-max">Veces por alumno (0 = sin límite)</Label>
              <Input
                id="perk-max"
                type="number"
                min={0}
                value={maxPerUser}
                onChange={(e) => setMaxPerUser(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perk-cooldown">Espera entre solicitudes (días)</Label>
              <Input
                id="perk-cooldown"
                type="number"
                min={0}
                value={cooldownDays}
                onChange={(e) => setCooldownDays(e.target.value)}
              />
            </div>
          </div>

          <Button onClick={() => void create()} disabled={busy || title.trim().length < 3}>
            {busy ? 'Creando…' : 'Crear beneficio'}
          </Button>
        </CardContent>
      </Card>

      {perks === null ? (
        <p className="text-sm text-text-muted">Cargando beneficios…</p>
      ) : perks.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">Ningún beneficio todavía</p>
            <p className="mt-1 text-sm text-text-muted">
              Sin beneficios, un nivel es solo un nombre.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {perks.map((perk) => (
            <Card key={perk.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-text">{perk.title}</p>
                    <Badge variant={perk.active ? 'success' : 'muted'}>
                      {perk.active ? 'Activo' : 'Pausado'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {perk.levelName} · {perk.levelMinPoints.toLocaleString('es-ES')} puntos ·{' '}
                    {perk.maxPerUser === 0 ? 'sin límite' : `${perk.maxPerUser} por alumno`}
                    {perk.cooldownDays > 0 ? ` · cada ${perk.cooldownDays} días` : ''}
                  </p>
                  {perk.description ? (
                    <p className="mt-1 text-sm text-text-muted">{perk.description}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" onClick={() => void toggle(perk)}>
                    {perk.active ? 'Pausar' : 'Activar'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void remove(perk)}>
                    Borrar
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Solicitudes de beneficio ─────────────────────────────────────────────────

function PerkRequestsPanel({ onError }: { onError: (m: string | null) => void }) {
  const [requests, setRequests] = useState<PerkRequestView[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [view, setView] = useState<'PENDING' | 'APPROVED' | 'CLOSED'>('PENDING');

  // Se traen TODAS y se filtran aquí: así los contadores de cada pestaña salen
  // gratis y ninguna solicitud queda invisible.
  const load = useCallback(async () => {
    setRequests(await gamificationAdminApi.listPerkRequests());
  }, []);

  useEffect(() => {
    load().catch((e) => onError(errorMessage(e, 'No pudimos cargar las solicitudes.')));
  }, [load, onError]);

  async function handle(request: PerkRequestView, status: 'APPROVED' | 'DONE' | 'REJECTED') {
    onError(null);
    try {
      const note = notes[request.id]?.trim();
      await gamificationAdminApi.handlePerkRequest(request.id, {
        status,
        ...(note ? { staffNote: note } : {}),
      });
      await load();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos registrar la respuesta.'));
    }
  }

  const all = requests ?? [];
  const porAprobar = all.filter((r) => r.status === 'PENDING');
  const porCumplir = all.filter((r) => r.status === 'APPROVED');
  const cerradas = all.filter((r) => r.status === 'DONE' || r.status === 'REJECTED');
  const visible = view === 'PENDING' ? porAprobar : view === 'APPROVED' ? porCumplir : cerradas;

  const TABS: Array<{ key: typeof view; label: string; count: number }> = [
    { key: 'PENDING', label: 'Por aprobar', count: porAprobar.length },
    { key: 'APPROVED', label: 'Por cumplir', count: porCumplir.length },
    { key: 'CLOSED', label: 'Historial', count: cerradas.length },
  ];

  const EMPTY: Record<typeof view, { title: string; hint: string }> = {
    PENDING: {
      title: 'No hay solicitudes por aprobar',
      hint: 'Aquí caen las peticiones de beneficios en cuanto alguien las manda.',
    },
    APPROVED: {
      title: 'No debes nada',
      hint: 'Lo que apruebas se queda aquí hasta que lo marcas como hecho.',
    },
    CLOSED: {
      title: 'Todavía no hay historial',
      hint: 'Aquí quedan las solicitudes ya cumplidas o rechazadas.',
    },
  };

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setView(t.key)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              view === t.key
                ? 'border-(--didacta-trust) bg-(--didacta-trust)/10 text-(--didacta-trust)'
                : 'border-border text-text-muted hover:text-text'
            }`}
          >
            {t.label}
            {t.count > 0 ? ` (${t.count})` : ''}
          </button>
        ))}
      </div>

      {requests === null ? (
        <p className="text-sm text-text-muted">Cargando solicitudes…</p>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-semibold text-text">{EMPTY[view].title}</p>
            <p className="mt-1 text-sm text-text-muted">{EMPTY[view].hint}</p>
          </CardContent>
        </Card>
      ) : (
        visible.map((r) => (
          <Card key={r.id}>
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-text">{r.perkTitle}</p>
                  <div className="flex flex-wrap items-center gap-1.5 text-sm text-text-muted">
                    <UserChip
                      userId={r.userId}
                      name={r.displayName}
                      fallback="Alumno"
                      showAvatar={false}
                      size={20}
                      nameClassName="block truncate text-sm text-text-muted"
                    />
                    <span>
                      · pedida el {new Date(r.createdAt).toLocaleDateString('es-ES')}
                      {r.handledAt
                        ? ` · respondida el ${new Date(r.handledAt).toLocaleDateString('es-ES')}`
                        : ''}
                    </span>
                  </div>
                </div>
                <Badge
                  variant={
                    r.status === 'DONE'
                      ? 'success'
                      : r.status === 'REJECTED'
                        ? 'muted'
                        : r.status === 'APPROVED'
                          ? 'warning'
                          : 'info'
                  }
                >
                  {r.status === 'PENDING'
                    ? 'Por aprobar'
                    : r.status === 'APPROVED'
                      ? 'Pendiente de cumplir'
                      : r.status === 'DONE'
                        ? 'Hecho'
                        : 'Rechazada'}
                </Badge>
              </div>

              {r.note ? (
                <p className="whitespace-pre-line rounded-lg bg-bg-subtle px-3 py-2 text-sm text-text-muted">
                  {r.note}
                </p>
              ) : null}

              {r.staffNote ? (
                <p className="whitespace-pre-line text-sm text-text-muted">
                  <span className="font-medium text-text">Tu respuesta:</span> {r.staffNote}
                </p>
              ) : null}

              {r.status === 'PENDING' || r.status === 'APPROVED' ? (
                <>
                  <Textarea
                    rows={2}
                    placeholder="Respuesta para el alumno (opcional)"
                    value={notes[r.id] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  />
                  <div className="flex flex-wrap gap-2">
                    {r.status === 'PENDING' ? (
                      <Button size="sm" onClick={() => void handle(r, 'APPROVED')}>
                        Aprobar
                      </Button>
                    ) : null}
                    <Button
                      variant={r.status === 'APPROVED' ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => void handle(r, 'DONE')}
                    >
                      Marcar hecho
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void handle(r, 'REJECTED')}>
                      Rechazar
                    </Button>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ── Reglas ───────────────────────────────────────────────────────────────────

function RulesPanel({ onError }: { onError: (m: string | null) => void }) {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [backfill, setBackfill] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setRules(await gamificationAdminApi.listRules());
  }, []);

  useEffect(() => {
    reload().catch((e) => onError(errorMessage(e, 'No pudimos cargar las reglas.')));
  }, [reload, onError]);

  async function save(rule: RuleView, patch: Partial<RuleView>) {
    onError(null);
    try {
      await gamificationAdminApi.updateRule(rule.key, {
        ...(patch.points !== undefined ? { points: patch.points } : {}),
        ...(patch.dailyCap !== undefined ? { dailyCap: patch.dailyCap } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      });
      await reload();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos guardar la regla.'));
    }
  }

  async function runBackfill() {
    setBusy(true);
    onError(null);
    setBackfill(null);
    try {
      const summary = await gamificationAdminApi.runBackfill();
      setBackfill(
        `Listo: ${summary.awarded} apunte(s) nuevos a partir de ${summary.posts} post(s), ` +
          `${summary.comments} comentario(s), ${summary.resources} recurso(s), ` +
          `${summary.courses} curso(s) terminado(s) y ${summary.referrals} referido(s).`,
      );
      await reload();
    } catch (e) {
      onError(errorMessage(e, 'No pudimos rellenar el histórico.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Cuánto vale cada cosa</CardTitle>
          <CardDescription>
            El techo diario limita cuántas veces al día puntúa una misma acción: es lo que evita que
            se sumen puntos publicando por publicar. Cero significa sin límite.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {rules === null ? (
            <p className="text-sm text-text-muted">Cargando reglas…</p>
          ) : (
            rules.map((rule) => (
              <div
                key={rule.key}
                className="flex flex-wrap items-end gap-3 border-b border-border pb-3 last:border-b-0 last:pb-0"
              >
                <div className="min-w-[180px] flex-1">
                  <p className="text-sm font-medium text-text">
                    {RULE_LABELS[rule.key] ?? rule.key}
                  </p>
                  <p className="text-xs text-text-muted">{rule.key}</p>
                </div>
                <div className="w-24 space-y-1">
                  <Label htmlFor={`pts-${rule.key}`} className="text-xs">
                    Puntos
                  </Label>
                  <Input
                    id={`pts-${rule.key}`}
                    type="number"
                    min={0}
                    defaultValue={rule.points}
                    onBlur={(e) => {
                      const points = Number(e.target.value);
                      if (points !== rule.points) void save(rule, { points });
                    }}
                  />
                </div>
                <div className="w-28 space-y-1">
                  <Label htmlFor={`cap-${rule.key}`} className="text-xs">
                    Techo/día
                  </Label>
                  <Input
                    id={`cap-${rule.key}`}
                    type="number"
                    min={0}
                    defaultValue={rule.dailyCap}
                    onBlur={(e) => {
                      const dailyCap = Number(e.target.value);
                      if (dailyCap !== rule.dailyCap) void save(rule, { dailyCap });
                    }}
                  />
                </div>
                <label className="flex items-center gap-2 pb-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => void save(rule, { enabled: e.target.checked })}
                  />
                  Activa
                </label>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rellenar el histórico</CardTitle>
          <CardDescription>
            Da puntos por la actividad anterior a los puntos, con su fecha original. Se puede
            repetir sin miedo: no duplica nada.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => void runBackfill()} disabled={busy}>
            {busy ? 'Rellenando…' : 'Rellenar ahora'}
          </Button>
          {backfill ? <p className="text-sm text-text-muted">{backfill}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
