'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { notificationLink } from '@/lib/notification-link';
import { useNotificationsContext, type ToastItem } from './notifications-provider';

/** Tiempo que un toast permanece visible antes de auto-descartarse (ms). */
const AUTO_DISMISS_MS = 8_000;

/**
 * Renderiza los toasts en vivo abajo-derecha. Se alimenta del
 * `NotificationsProvider` (que escucha el stream SSE); no abre su propia
 * conexión. Cada toast se auto-descarta y, si la notificación tiene una acción
 * de navegación (p. ej. "Responder"), ofrece el enlace directo.
 *
 * La esquina inferior derecha la comparte con el chat flotante. En vez de
 * ajustar offsets a mano cada vez que cambia la altura de la píldora o le
 * aparecen avisos encima, el chat publica su borde superior en
 * `--didacta-chat-corner` (px desde el fondo del viewport) y los toasts se
 * apilan justo por encima. Sin chat montado, el valor por defecto deja sitio al
 * tab bar móvil.
 */
export function NotificationsToaster() {
  const { toasts, dismissToast } = useNotificationsContext();

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-[calc(var(--didacta-chat-corner,8rem)+0.75rem)] z-(--z-toast) flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
      aria-relevant="additions"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const { id } = toast;

  useEffect(() => {
    const handle = setTimeout(() => onDismiss(id), AUTO_DISMISS_MS);
    return () => clearTimeout(handle);
  }, [id, onDismiss]);

  const link = notificationLink(toast.templateKey, toast.metadata);
  const title = toast.subject ?? 'Nueva notificación';

  return (
    <div
      role="status"
      className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border-soft bg-surface p-3 shadow-lg ring-1 ring-black/5 animate-in slide-in-from-bottom-2 fade-in"
    >
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg"
        style={{ background: 'var(--didacta-info-bg)', color: 'var(--didacta-info-fg)' }}
      >
        <BellIcon />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug text-text">{title}</p>
        {link ? (
          <Link
            href={link.href}
            onClick={() => onDismiss(id)}
            className="mt-1 inline-block text-xs font-semibold text-[var(--didacta-info-fg)] hover:underline"
          >
            {link.actionLabel}
          </Link>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(id)}
        aria-label="Cerrar notificación"
        className="shrink-0 rounded-md p-1 text-text-subtle transition-colors hover:bg-neutral-100 hover:text-text dark:hover:bg-neutral-800"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="h-4 w-4"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.6}
      stroke="currentColor"
      className="h-4 w-4"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
      />
    </svg>
  );
}
