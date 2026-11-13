'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import {
  AGENT_IDS,
  AGENT_LABELS,
  agentScreenFor,
  agentSnippet,
  mcpUrlFor,
  readCollapsed,
  readTab,
  serverNameFor,
  writeCollapsed,
  writeTab,
  type AgentId,
  type AgentScreenMatch,
} from '@/lib/agent-connect';
import { agentKeysApi, type CreatedAgentKey } from '@/lib/agent-keys';
import { coursesApi } from '@/lib/courses';
import { cn } from '@/lib/utils';

/**
 * Panel «Hazlo más rápido con tu agente de IA» del MODO SENCILLO.
 *
 * Solo para quien administra el aula y solo en las pantallas donde hoy se
 * crea algo a mano (`agentScreenFor`). Explica qué pedirle al agente en ESA
 * pantalla, crea la clave de conexión (se enseña una vez) y da el comando o
 * la configuración de cada agente con la URL del servidor MCP del aula y la
 * clave ya puestas.
 *
 * - Escritorio: columna a la derecha del contenido (no lo tapa: el contenido
 *   se estrecha) y plegable a una pestaña lateral. Plegado se recuerda.
 * - Móvil: un botón en el flujo de la página que abre una hoja inferior.
 *
 * El estado vive en `useAgentPanel` (lo tiene el armazón), para que la clave
 * recién creada no se pierda al plegar o al cambiar de pantalla. La clave en
 * claro solo vive en memoria: nunca en el almacenamiento del navegador.
 */

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface AgentPanelState {
  match: AgentScreenMatch | null;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  /** Panel desplegado como columna en escritorio. */
  dockOpen: boolean;
  created: CreatedAgentKey | null;
  setCreated: (k: CreatedAgentKey | null) => void;
  sheetOpen: boolean;
  setSheetOpen: (v: boolean) => void;
}

export function useAgentPanel(pathname: string, isAdmin: boolean): AgentPanelState {
  const match = isAdmin ? agentScreenFor(pathname) : null;
  const [collapsed, setCollapsedState] = useState<boolean>(() => readCollapsed(safeLocalStorage()));
  const [created, setCreated] = useState<CreatedAgentKey | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => setSheetOpen(false), [pathname]);
  return {
    match,
    collapsed,
    setCollapsed: (v) => {
      setCollapsedState(v);
      writeCollapsed(safeLocalStorage(), v);
    },
    dockOpen: Boolean(match) && !collapsed,
    created,
    setCreated,
    sheetOpen,
    setSheetOpen,
  };
}

interface PanelProps {
  state: AgentPanelState;
  tenantSlug: string | null | undefined;
}

/** Columna de escritorio (la pinta el armazón a la derecha del contenido). */
export function AgentPanelDock({ state, tenantSlug, top }: PanelProps & { top: number }) {
  if (!state.match || state.collapsed) return null;
  return (
    <aside
      className="sticky hidden w-[340px] shrink-0 self-start overflow-y-auto rounded-2xl border border-border bg-surface shadow-sm lg:block"
      style={{ top: top + 16, maxHeight: `calc(100dvh - ${top + 32}px)` }}
      data-testid="agente-ia-panel"
    >
      <PanelBody state={state} tenantSlug={tenantSlug} onClose={() => state.setCollapsed(true)} />
    </aside>
  );
}

/** Pestaña lateral pequeña del panel plegado (escritorio). */
export function AgentPanelTab({ state, top }: { state: AgentPanelState; top: number }) {
  const t = useTranslations('agenteIa');
  if (!state.match || !state.collapsed) return null;
  return (
    <button
      type="button"
      onClick={() => state.setCollapsed(false)}
      className="fixed right-0 z-(--z-sticky) hidden items-center gap-2 rounded-l-xl border border-r-0 border-border bg-surface px-2 py-3 text-[13px] font-semibold text-brand-700 shadow-sm hover:bg-brand-50 lg:flex"
      style={{ top: top + 96, writingMode: 'vertical-rl' }}
      aria-label={t('titulo')}
      data-testid="agente-ia-plegado"
    >
      <Icon name="ai" size={16} />
      {t('pestana')}
    </button>
  );
}

/** Móvil: botón en el flujo de la página y hoja inferior. */
export function AgentPanelMobile({ state, tenantSlug }: PanelProps) {
  const t = useTranslations('agenteIa');
  useEffect(() => {
    if (!state.sheetOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && state.setSheetOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);
  if (!state.match) return null;
  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => state.setSheetOpen(true)}
        className="mb-4 flex w-full items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-2.5 text-left shadow-sm"
        data-testid="agente-ia-movil"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon name="ai" size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
          {t('abrirMovil')}
        </span>
        <Icon name="chevron-right" size={16} className="text-text-subtle" />
      </button>
      {state.sheetOpen ? (
        <div className="fixed inset-0 z-(--z-modal) flex flex-col justify-end">
          <button
            type="button"
            aria-label={t('cerrar')}
            className="absolute inset-0 bg-black/40"
            onClick={() => state.setSheetOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('titulo')}
            className="relative max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-surface shadow-lg"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            data-testid="agente-ia-hoja"
          >
            <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-border" />
            <PanelBody
              state={state}
              tenantSlug={tenantSlug}
              onClose={() => state.setSheetOpen(false)}
              closeIcon="x"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Cuerpo ─────────────────────────────────────────────────────────────────

function PanelBody({
  state,
  tenantSlug,
  onClose,
  closeIcon = 'chevron-right',
}: PanelProps & { onClose: () => void; closeIcon?: 'chevron-right' | 'x' }) {
  const t = useTranslations('agenteIa');
  const match = state.match!;
  const [courseTitle, setCourseTitle] = useState<string | null>(null);
  const [activeKeys, setActiveKeys] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [tab, setTabState] = useState<AgentId>(() => readTab(safeLocalStorage()));
  const setTab = (id: AgentId) => {
    setTabState(id);
    writeTab(safeLocalStorage(), id);
  };

  // El ejemplo del editor lleva el título REAL del curso abierto.
  useEffect(() => {
    if (match.screen !== 'course-edit' || !match.courseId) return;
    let cancelled = false;
    coursesApi
      .get(match.courseId)
      .then((c) => !cancelled && setCourseTitle(c.title))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [match.screen, match.courseId]);

  useEffect(() => {
    let cancelled = false;
    agentKeysApi
      .activeCount()
      .then((n) => !cancelled && setActiveKeys(n))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [state.created]);

  async function create() {
    setBusy(true);
    setError(null);
    setRevoked(false);
    try {
      state.setCreated(await agentKeysApi.create());
    } catch {
      setError(t('errorCrear'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!state.created) return;
    try {
      await agentKeysApi.revoke(state.created.id);
      state.setCreated(null);
      setRevoked(true);
    } catch {
      setError(t('errorCrear'));
    }
  }

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const url = mcpUrlFor(origin);
  const name = serverNameFor(tenantSlug);
  const key = state.created?.token ?? t('placeholder');
  const snippet = agentSnippet(tab, { url, key, name });

  const example =
    match.screen === 'course-edit'
      ? courseTitle
        ? t('ejemplos.courseEdit', { curso: courseTitle })
        : t('ejemplos.courseEditSinTitulo')
      : match.screen === 'course-new'
        ? t('ejemplos.courseNew')
        : match.screen === 'courses'
          ? t('ejemplos.courses')
          : match.screen === 'live'
            ? t('ejemplos.live')
            : t('ejemplos.community');

  return (
    <div className="grid gap-4 p-4" data-screen={match.screen}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon name="ai" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] leading-snug font-bold text-text">{t('titulo')}</h2>
          <p className="mt-0.5 text-[13px] leading-5 text-text-muted">{t('sub')}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeIcon === 'x' ? t('cerrar') : t('ocultar')}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-text-subtle hover:bg-bg-subtle hover:text-text"
          data-testid="agente-ia-ocultar"
        >
          <Icon name={closeIcon} size={16} />
        </button>
      </div>

      <section>
        <p className="text-[13px] font-semibold text-text">{t('ejemploTitulo')}</p>
        <div className="mt-1.5 flex items-start gap-2 rounded-xl bg-brand-50 p-3">
          <p
            className="min-w-0 flex-1 text-[13px] leading-relaxed text-text"
            data-testid="agente-ia-ejemplo"
          >
            {example}
          </p>
          <CopyButton text={example} compact />
        </div>
      </section>

      <section className="grid gap-2">
        <StepTitle n={1}>{t('paso1')}</StepTitle>
        {state.created ? (
          <>
            <CodeBlock text={state.created.token} testId="agente-ia-clave" />
            <p className="text-[12px] leading-5 font-semibold text-warning-700">
              {t('claveUnaVez')}
            </p>
            <button
              type="button"
              onClick={() => void revoke()}
              className="justify-self-start text-[12px] font-semibold text-text-muted hover:text-text hover:underline"
            >
              {t('revocar')}
            </button>
          </>
        ) : (
          <>
            <p className="text-[13px] leading-5 text-text-muted">{t('paso1Ayuda')}</p>
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              data-testid="agente-ia-crear-clave"
            >
              {busy ? t('creando') : t('crearClave')}
            </button>
            {revoked ? <p className="text-[12px] text-text-muted">{t('revocada')}</p> : null}
            {activeKeys && activeKeys > 0 ? (
              <p className="text-[12px] leading-5 text-text-muted">
                {t('clavesActivas', { count: activeKeys })}{' '}
                <Link
                  href="/admin/api-keys"
                  className="font-semibold text-brand-600 hover:underline"
                >
                  {t('gestionar')}
                </Link>
              </p>
            ) : null}
          </>
        )}
        {error ? <p className="text-[12px] font-semibold text-danger-700">{error}</p> : null}
      </section>

      <section className="grid gap-2">
        <StepTitle n={2}>{t('paso2')}</StepTitle>
        <div className="grid grid-cols-3 gap-1.5" role="tablist" aria-label={t('paso2')}>
          {AGENT_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'h-8 truncate rounded-lg border px-2 text-[12px] font-semibold',
                tab === id
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-border text-text-muted hover:border-border-strong hover:text-text',
              )}
              data-testid={`agente-ia-tab-${id}`}
            >
              {AGENT_LABELS[id]}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="grid gap-2" data-agent={tab}>
          {snippet.blocks.map((b, i) => (
            <div key={`${tab}-${b.step}`} className="grid gap-1.5">
              <p className="text-[13px] leading-5 text-text">
                {t(`agentes.${tab}.${b.step}` as 'agentes.codex.paso')}
              </p>
              <CodeBlock text={b.text} testId={i === 0 ? 'agente-ia-codigo' : undefined} />
            </div>
          ))}
          {snippet.verify ? (
            <p className="text-[12px] text-text-muted">
              {t('comprobar')}{' '}
              <code className="rounded bg-bg-subtle px-1 py-0.5 font-mono text-[12px] text-text">
                {snippet.verify}
              </code>
            </p>
          ) : null}
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
            {snippet.docs.map((href) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-brand-600 hover:underline"
              >
                {t('guia')} · {new URL(href).hostname.replace(/^www\./, '')} ↗
              </a>
            ))}
          </p>
        </div>
      </section>

      <section className="grid gap-1 border-t border-border-soft pt-3 text-[12px] leading-relaxed text-text-muted">
        <p>{t('puede')}</p>
        <p>{t('noPuede')}</p>
        <p>{t('chatgpt')}</p>
      </section>
    </div>
  );
}

function StepTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[13px] font-bold text-text">
      <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-[11px] font-bold text-white tabular-nums">
        {n}
      </span>
      {children}
    </p>
  );
}

function CodeBlock({ text, testId }: { text: string; testId?: string }) {
  return (
    <div className="relative rounded-xl border border-border-soft bg-bg-subtle">
      <pre
        className="max-h-56 overflow-auto p-3 pr-11 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-text [overflow-wrap:anywhere]"
        data-testid={testId}
      >
        {text}
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton text={text} compact />
      </div>
    </div>
  );
}

function CopyButton({ text, compact }: { text: string; compact?: boolean }) {
  const t = useTranslations('agenteIa');
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Sin portapapeles: el texto sigue a la vista para copiarlo a mano.
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? t('copiado') : t('copiar')}
      title={copied ? t('copiado') : t('copiar')}
      className={cn(
        'grid shrink-0 place-items-center rounded-lg border border-border bg-surface text-text-muted hover:border-border-strong hover:text-text',
        compact ? 'h-8 w-8' : 'h-9 w-9',
        copied && 'border-success-200 text-success-700',
      )}
      data-testid="agente-ia-copiar"
    >
      <Icon name={copied ? 'check' : 'copy'} size={15} />
    </button>
  );
}
