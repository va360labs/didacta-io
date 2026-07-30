'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Icon } from '@/components/icon';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { uploadCommunityFile } from '@/lib/community-upload';
import { gamificationApi, type ChallengeView, type MyPerkView } from './client';

/**
 * Modal de entrega de un reto.
 *
 * Dos pasos a propósito: el formulario y, antes de enviar, una pantalla de
 * confirmación que enseña lo que se va a mandar. La entrega es única por reto
 * y persona —la unique de BD lo impide— así que no hay segunda oportunidad
 * para corregir un archivo equivocado.
 */

const inputClass =
  'w-full rounded-lg border border-border bg-surface p-2.5 text-sm text-text placeholder:text-text-subtle focus:border-border-strong focus:outline-none';

/**
 * El texto del control nativo de fichero ("Choose File / No file chosen") lo
 * pone el navegador en su propio idioma y no hay forma de traducirlo ni con
 * CSS. Como esta pantalla la ve el alumno, se oculta el input y se dispara
 * desde un botón propio en español.
 */
function FileField({
  id,
  onPick,
  fileName,
  onClear,
  disabled,
}: {
  id: string;
  onPick: (input: HTMLInputElement) => void;
  fileName: string | null;
  onClear: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        id={id}
        type="file"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => onPick(e.currentTarget)}
      />
      <label
        htmlFor={id}
        className="cursor-pointer rounded-lg bg-(--didacta-trust) px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
      >
        {fileName ? 'Cambiar archivo' : 'Elegir archivo'}
      </label>
      {fileName ? (
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-text-muted">
          <Icon name="check" size={14} />
          <span className="truncate">{fileName}</span>
          <button
            type="button"
            onClick={onClear}
            className="text-text-subtle underline hover:text-text"
          >
            quitar
          </button>
        </span>
      ) : (
        <span className="text-sm text-text-subtle">Ningún archivo seleccionado</span>
      )}
    </div>
  );
}

/**
 * Modal para pedir un beneficio de nivel (una sesión 1:1, una clase extra…).
 * No concede nada: crea una solicitud que atiende una persona, y así se lo
 * dice al alumno para no generar la expectativa de algo inmediato.
 */
export function RequestPerkModal({
  perk,
  open,
  onOpenChange,
  onRequested,
}: {
  perk: MyPerkView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequested: () => void | Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setNote('');
    setError(null);
    setBusy(false);
  }, [open]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await gamificationApi.requestPerk(perk.id, note.trim() ? { note: note.trim() } : {});
      onOpenChange(false);
      await onRequested();
    } catch (e) {
      setError(
        e instanceof ApiHttpError || e instanceof Error
          ? e.message
          : 'No se pudo enviar la solicitud.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <div className="space-y-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Pedir beneficio
            </p>
            <h2 className="mt-0.5 text-base font-bold text-text">{perk.title}</h2>
            <p className="mt-1 text-sm text-text-muted">
              Desbloqueado con el nivel {perk.levelName}.
            </p>
          </div>

          {perk.description ? (
            <p className="whitespace-pre-line rounded-lg bg-bg-subtle px-3 py-2 text-sm text-text-muted">
              {perk.description}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="perk-nota">¿Algo que debamos saber antes? (opcional)</Label>
            <Textarea
              id="perk-nota"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Por ejemplo, qué te gustaría trabajar o tu disponibilidad."
            />
          </div>

          <p className="text-sm text-text-muted">
            Al enviarlo queda como solicitud pendiente: te escribiremos para cuadrarlo.
            {perk.quotaLeft !== null
              ? ` Te ${perk.quotaLeft === 1 ? 'queda' : 'quedan'} ${perk.quotaLeft}.`
              : ''}
          </p>

          {error ? <p className="text-sm text-(--didacta-coral)">{error}</p> : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? 'Enviando…' : 'Enviar solicitud'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface Proof {
  url: string;
  name: string;
  /** Distingue el adjunto subido del enlace pegado, solo para el resumen. */
  kind: 'file' | 'link';
}

export function SubmitChallengeModal({
  challenge,
  open,
  onOpenChange,
  onSubmitted,
}: {
  challenge: ChallengeView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void | Promise<void>;
}) {
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [note, setNote] = useState('');
  const [link, setLink] = useState('');
  const [file, setFile] = useState<{ url: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Al cerrar, el formulario vuelve a cero: si no, reabrirlo enseñaría los
  // restos del intento anterior.
  useEffect(() => {
    if (open) return;
    setStep('form');
    setNote('');
    setLink('');
    setFile(null);
    setError(null);
    setBusy(false);
  }, [open]);

  const proof: Proof | null = file
    ? { url: file.url, name: file.name, kind: 'file' }
    : link.trim()
      ? { url: link.trim(), name: link.trim(), kind: 'link' }
      : null;

  const handleFile = useCallback(async (input: HTMLInputElement) => {
    const picked = input.files?.[0];
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadCommunityFile(picked);
      setFile({ url: uploaded.url, name: picked.name });
      // Subir un archivo manda sobre el enlace: una sola prueba por entrega.
      setLink('');
    } catch {
      setError('No se pudo subir el archivo. Prueba con otro formato o tamaño.');
    } finally {
      setBusy(false);
      input.value = '';
    }
  }, []);

  function goToConfirm() {
    if (challenge.proofRequired && !proof) {
      setError('Este reto exige adjuntar la prueba: sube el archivo o pega el enlace.');
      return;
    }
    setError(null);
    setStep('confirm');
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await gamificationApi.submit(challenge.id, {
        ...(proof ? { proofUrl: proof.url } : {}),
        ...(file ? { proofName: file.name } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onOpenChange(false);
      await onSubmitted();
    } catch (e) {
      setError(
        e instanceof ApiHttpError || e instanceof Error
          ? e.message
          : 'No se pudo enviar la entrega.',
      );
      setStep('form');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {step === 'form' ? (
          <div className="space-y-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Entregar reto
              </p>
              <h2 className="mt-0.5 text-base font-bold text-text">{challenge.title}</h2>
              <p className="mt-1 text-sm text-text-muted">
                Vale {challenge.points} puntos. La revisa el equipo antes de acreditarlos.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="entrega-nota">Cuéntanos qué has hecho</Label>
              <Textarea
                id="entrega-nota"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Un par de líneas sobre el resultado."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="entrega-archivo">
                Sube la prueba{challenge.proofRequired ? '' : ' (opcional)'}
              </Label>
              <FileField
                id="entrega-archivo"
                onPick={(input) => void handleFile(input)}
                fileName={file?.name ?? null}
                onClear={() => setFile(null)}
                disabled={busy}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="entrega-enlace">…o pega un enlace</Label>
              <input
                id="entrega-enlace"
                type="url"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://…"
                disabled={file !== null}
                className={inputClass}
              />
            </div>

            {error ? <p className="text-sm text-(--didacta-coral)">{error}</p> : null}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button onClick={goToConfirm} disabled={busy}>
                {busy ? 'Subiendo…' : 'Continuar'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Confirmar entrega
              </p>
              <h2 className="mt-0.5 text-base font-bold text-text">{challenge.title}</h2>
            </div>

            <div className="rounded-lg border border-border bg-bg-subtle p-3 text-sm">
              <p className="font-medium text-text">Esto es lo que vas a enviar:</p>
              <dl className="mt-2 space-y-1.5 text-text-muted">
                <div>
                  <dt className="inline font-medium text-text">Prueba: </dt>
                  <dd className="inline break-all">
                    {proof ? (proof.kind === 'file' ? proof.name : proof.url) : 'sin adjuntar'}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium text-text">Comentario: </dt>
                  <dd className="inline whitespace-pre-line">{note.trim() || 'sin comentario'}</dd>
                </div>
              </dl>
            </div>

            <p className="text-sm text-text-muted">
              Solo puedes entregar este reto una vez, así que revísalo antes de enviar.
            </p>

            {error ? <p className="text-sm text-(--didacta-coral)">{error}</p> : null}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setStep('form')} disabled={busy}>
                Volver
              </Button>
              <Button onClick={() => void submit()} disabled={busy}>
                {busy ? 'Enviando…' : 'Confirmar y enviar'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
