'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { uploadCommunityFile } from '@/lib/community-upload';
import {
  gamificationApi,
  type ChallengeView,
  type LevelView,
  type Standing,
} from '@/modules/gamification';

const STATUS_LABEL: Record<string, { label: string; variant: 'info' | 'success' | 'danger' }> = {
  PENDING: { label: 'En revisión', variant: 'info' },
  APPROVED: { label: 'Aprobado', variant: 'success' },
  REJECTED: { label: 'No aprobado', variant: 'danger' },
};

export default function RetosPage() {
  const [challenges, setChallenges] = useState<ChallengeView[]>([]);
  const [levels, setLevels] = useState<LevelView[]>([]);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, levelList, mine] = await Promise.all([
        gamificationApi.listChallenges(),
        gamificationApi.listLevels(),
        gamificationApi.myStanding('all'),
      ]);
      setChallenges(list);
      setLevels(levelList);
      setStanding(mine);
    } catch {
      setError('No se pudieron cargar los retos.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nextLevel = levels.find((l) => l.minPoints > (standing?.lifetimePoints ?? 0));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">Retos</h1>
        <p className="mt-1 text-sm text-text-muted">
          Completa retos, sube tu prueba y suma puntos. Las entregas las revisa el equipo.
        </p>
      </div>

      {standing ? (
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-border bg-surface px-5 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Puntos acumulados
            </p>
            <p className="font-display text-xl font-bold text-text">
              {standing.lifetimePoints.toLocaleString('es-ES')}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Tu nivel
            </p>
            <p className="font-display text-xl font-bold text-text">{standing.levelName ?? '—'}</p>
          </div>
          {nextLevel ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Siguiente nivel
              </p>
              <p className="text-sm text-text">
                <span className="font-semibold">{nextLevel.name}</span> a{' '}
                {(nextLevel.minPoints - standing.lifetimePoints).toLocaleString('es-ES')} puntos
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {levels.length > 0 ? (
        <section className="space-y-3">
          <h2 className="font-display text-lg font-semibold text-text">Niveles</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {levels.map((level) => {
              const reached = (standing?.lifetimePoints ?? 0) >= level.minPoints;
              return (
                <div
                  key={level.id}
                  className={`rounded-xl border p-4 ${
                    reached
                      ? 'border-(--didacta-trust) bg-(--didacta-trust)/5'
                      : 'border-border bg-surface'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-text">{level.name}</p>
                    {reached ? <Badge variant="success">Alcanzado</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    Desde {level.minPoints.toLocaleString('es-ES')} puntos
                  </p>
                  {level.benefitText ? (
                    <p className="mt-2 text-sm text-text-muted">{level.benefitText}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold text-text">Retos abiertos</h2>
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
          <div className="space-y-3">
            {challenges.map((challenge) => (
              <ChallengeCard key={challenge.id} challenge={challenge} onDone={load} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ChallengeCard({
  challenge,
  onDone,
}: {
  challenge: ChallengeView;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [link, setLink] = useState('');
  const [file, setFile] = useState<{ url: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submitted = challenge.mySubmission;
  const badge = submitted ? STATUS_LABEL[submitted.status] : null;

  async function handleFile(input: HTMLInputElement) {
    const picked = input.files?.[0];
    if (!picked) return;
    setBusy(true);
    setFormError(null);
    try {
      const uploaded = await uploadCommunityFile(picked);
      setFile({ url: uploaded.url, name: picked.name });
    } catch {
      setFormError('No se pudo subir el archivo. Prueba con otro formato o tamaño.');
    } finally {
      setBusy(false);
      input.value = '';
    }
  }

  async function submit() {
    setBusy(true);
    setFormError(null);
    try {
      const proofUrl = file?.url ?? (link.trim() || undefined);
      await gamificationApi.submit(challenge.id, {
        ...(proofUrl ? { proofUrl } : {}),
        ...(file ? { proofName: file.name } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setOpen(false);
      await onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'No se pudo enviar la entrega.';
      setFormError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-text">{challenge.title}</h3>
            {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
            {challenge.proofRequired ? <Badge variant="muted">Con prueba</Badge> : null}
          </div>
          {challenge.description ? (
            <p className="mt-1.5 whitespace-pre-line text-sm text-text-muted">
              {challenge.description}
            </p>
          ) : null}
          {submitted?.reviewNote ? (
            <p className="mt-2 rounded-lg bg-bg-subtle px-3 py-2 text-sm text-text-muted">
              <span className="font-medium text-text">Respuesta del equipo:</span>{' '}
              {submitted.reviewNote}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="font-display text-lg font-bold text-(--didacta-trust)">
            +{challenge.points}
          </span>
          {!submitted ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="rounded-lg bg-(--didacta-trust) px-3 py-1.5 text-sm font-medium text-white"
            >
              {open ? 'Cancelar' : 'Entregar'}
            </button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <div>
            <label
              htmlFor={`nota-${challenge.id}`}
              className="text-xs font-semibold uppercase tracking-wide text-text-muted"
            >
              Cuéntanos qué has hecho
            </label>
            <textarea
              id={`nota-${challenge.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text"
              placeholder="Un par de líneas sobre el resultado."
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`archivo-${challenge.id}`}
                className="text-xs font-semibold uppercase tracking-wide text-text-muted"
              >
                Sube la prueba
              </label>
              <input
                id={`archivo-${challenge.id}`}
                type="file"
                onChange={(e) => void handleFile(e.currentTarget)}
                className="mt-1 w-full text-sm text-text-muted"
              />
              {file ? (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
                  <Icon name="check" size={14} />
                  {file.name}
                </p>
              ) : null}
            </div>
            <div>
              <label
                htmlFor={`enlace-${challenge.id}`}
                className="text-xs font-semibold uppercase tracking-wide text-text-muted"
              >
                …o pega un enlace
              </label>
              <input
                id={`enlace-${challenge.id}`}
                type="url"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://…"
                className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text"
              />
            </div>
          </div>

          {formError ? <p className="text-sm text-(--didacta-coral)">{formError}</p> : null}

          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded-lg bg-(--didacta-trust) px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy ? 'Enviando…' : 'Enviar entrega'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
