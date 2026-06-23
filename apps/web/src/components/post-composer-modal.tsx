'use client';

import { useEffect, useRef, useState } from 'react';
import { authStorage } from '@/lib/auth-storage';
import { communityApi, useCommunitySpaces } from '@/modules/community';

function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

interface Props {
  open: boolean;
  onClose: () => void;
  spaceSlug: string;
  onSuccess: () => void;
}

export function PostComposerModal({ open, onClose, spaceSlug, onSuccess }: Props) {
  const session = authStorage.getSession();
  const userName = session?.user.name ?? session?.user.email ?? 'Usuario';
  const spaces = useCommunitySpaces();

  const [selectedSpace, setSelectedSpace] = useState(spaceSlug);
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setSelectedSpace(spaceSlug);
      setTitle('');
      setBody('');
      setTags([]);
      setTagInput('');
      setError(null);
      setTimeout(() => titleRef.current?.focus(), 50);
    }
  }, [open, spaceSlug]);

  // Cierra con Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const spaceMeta = spaces.find((s) => s.slug === selectedSpace) ?? spaces[0];
  const canSubmit = title.trim().length >= 3 && body.trim().length >= 1 && !submitting;

  function addTag(raw: string) {
    const t = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    if (t && !tags.includes(t) && tags.length < 9) setTags((prev) => [...prev, t]);
    setTagInput('');
  }

  function handleTagKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === 'Backspace' && tagInput === '') {
      setTags((prev) => prev.slice(0, -1));
    }
  }

  // Helpers de formato sobre el textarea
  function wrapSelection(before: string, after = before) {
    const ta = bodyRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end);
    const next = ta.value.slice(0, start) + before + selected + after + ta.value.slice(end);
    setBody(next);
    ta.focus();
    setTimeout(() => ta.setSelectionRange(start + before.length, end + before.length), 0);
  }

  function insertListItem() {
    const ta = bodyRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
    const next = ta.value.slice(0, lineStart) + '- ' + ta.value.slice(lineStart);
    setBody(next);
    ta.focus();
    setTimeout(() => ta.setSelectionRange(start + 2, start + 2), 0);
  }

  function insertLink() {
    const url = window.prompt('URL del enlace:');
    if (!url) return;
    const ta = bodyRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end) || 'enlace';
    const replacement = `[${selected}](${url})`;
    setBody(ta.value.slice(0, start) + replacement + ta.value.slice(end));
    ta.focus();
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const allTags = [...new Set([selectedSpace, ...tags])];
      await communityApi.createPost({ title: title.trim(), body: body.trim(), tags: allTags });
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al publicar');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-0">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#0D1B2A] text-sm font-bold text-white">
            {initials(userName)}
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-[#0D1B2A]">{userName}</p>

            {/* Space selector */}
            <div className="relative mt-0.5 inline-block">
              <button
                type="button"
                onClick={() => setSpaceOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-full border border-[#1E5AA8]/30 bg-[#1E5AA8]/8 px-2.5 py-0.5 text-xs font-semibold text-[#1E5AA8] hover:bg-[#1E5AA8]/15 transition-colors"
              >
                <span className="text-[#1E5AA8]">#</span>
                Publicando en {spaceMeta?.title ?? selectedSpace}
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="opacity-70"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {spaceOpen && (
                <div className="absolute top-full left-0 mt-1 w-52 rounded-xl border border-[#E2E8F0] bg-white shadow-lg z-20">
                  {spaces.map((s) => (
                    <button
                      key={s.slug}
                      type="button"
                      onClick={() => {
                        setSelectedSpace(s.slug);
                        setSpaceOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-[#F1F5F9] ${selectedSpace === s.slug ? 'font-semibold text-[#1E5AA8]' : 'text-[#374151]'}`}
                    >
                      <span className="text-[#1E5AA8] font-bold">{s.icon}</span>
                      {s.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Close */}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto grid h-8 w-8 place-items-center rounded-full text-[#94A3B8] transition-colors hover:bg-[#F1F5F9] hover:text-[#374151]"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 pt-4 space-y-3">
          {/* Título */}
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título de la publicación"
            maxLength={200}
            className="w-full border-none bg-transparent text-2xl font-bold text-[#0D1B2A] placeholder:text-[#CBD5E1] focus:outline-none"
          />

          {/* Cuerpo */}
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Escribe aquí el contenido…"
            rows={4}
            maxLength={10000}
            className="w-full resize-none border-none bg-transparent text-[15px] leading-relaxed text-[#374151] placeholder:text-[#CBD5E1] focus:outline-none"
          />

          {/* Tags */}
          <div className="flex flex-wrap items-center gap-2 min-h-[32px]">
            {tags.map((t) => (
              <span
                key={t}
                className="flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1 text-xs font-medium text-[#374151]"
              >
                <span className="text-[#94A3B8]">#</span>
                {t}
                <button
                  type="button"
                  onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                  className="ml-0.5 text-[#94A3B8] hover:text-[#374151] transition-colors leading-none"
                >
                  ×
                </button>
              </span>
            ))}
            {tags.length < 9 && (
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKey}
                onBlur={() => tagInput && addTag(tagInput)}
                placeholder="+ Añadir tag"
                className="border border-dashed border-[#CBD5E1] rounded-full px-3 py-1 text-xs text-[#94A3B8] placeholder:text-[#CBD5E1] focus:outline-none focus:border-[#1E5AA8] focus:text-[#374151] bg-transparent w-28 transition-colors"
              />
            )}
          </div>
        </div>

        <div className="mx-5 mt-3 h-px bg-[#F1F5F9]" />

        {/* Toolbar */}
        <div className="flex items-center gap-1 px-5 py-3">
          <button
            type="button"
            onClick={() => wrapSelection('**')}
            title="Negrita"
            className="grid h-8 w-8 place-items-center rounded-lg text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0D1B2A] transition-colors font-bold text-sm"
          >
            B
          </button>
          <button
            type="button"
            onClick={insertListItem}
            title="Lista"
            className="grid h-8 w-8 place-items-center rounded-lg text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0D1B2A] transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <circle cx="3" cy="6" r="1" fill="currentColor" />
              <circle cx="3" cy="12" r="1" fill="currentColor" />
              <circle cx="3" cy="18" r="1" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            onClick={insertLink}
            title="Enlace"
            className="grid h-8 w-8 place-items-center rounded-lg text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0D1B2A] transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>

          <div className="mx-1 h-5 w-px bg-[#E2E8F0]" />

          {/* Imagen, adjunto, encuesta, emoji — decorativos (sin backend aún) */}
          {[
            {
              title: 'Imagen',
              icon: (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              ),
            },
            {
              title: 'Adjunto',
              icon: (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              ),
            },
            {
              title: 'Encuesta',
              icon: (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
              ),
            },
            {
              title: 'Emoji',
              icon: (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  <line x1="9" y1="9" x2="9.01" y2="9" />
                  <line x1="15" y1="9" x2="15.01" y2="9" />
                </svg>
              ),
            },
          ].map(({ title: t, icon }) => (
            <button
              key={t}
              type="button"
              title={t}
              className="grid h-8 w-8 place-items-center rounded-lg text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0D1B2A] transition-colors opacity-60 cursor-not-allowed"
            >
              {icon}
            </button>
          ))}
        </div>

        <div className="mx-5 h-px bg-[#F1F5F9]" />

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4">
          <p className="flex items-center gap-1.5 text-xs text-[#94A3B8]">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            Visible para toda la comunidad
          </p>

          <div className="flex items-center gap-3">
            {error && <p className="text-xs text-red-500">{error}</p>}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-[#374151] hover:text-[#0D1B2A] transition-colors"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex items-center gap-2 rounded-xl bg-[#0D1B2A] px-5 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <span>→</span> Publicar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
