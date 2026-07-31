'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { MESSAGE_MAX_LENGTH, TYPING_THROTTLE_MS } from './constants';

/**
 * Campo de escritura compartido por `/mensajes` y el hilo del chat flotante.
 *
 * Aquí vive el acelerador del indicador «está escribiendo» (ADR-019): como
 * mucho un aviso cada `TYPING_THROTTLE_MS`, y ninguno con el campo vacío. Al
 * estar en el componente compartido, las dos superficies lo emiten sin
 * duplicar la regla.
 */
export function MessageComposer({
  value,
  onChange,
  onSend,
  sending,
  onTyping,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  /** Aviso de escritura ya acelerado; best-effort, nunca bloquea el envío. */
  onTyping?: () => void;
  compact?: boolean;
}) {
  const lastTypingAtRef = useRef(0);

  const handleChange = useCallback(
    (next: string) => {
      onChange(next);
      if (!onTyping || next.trim().length === 0) return;
      const now = Date.now();
      if (now - lastTypingAtRef.current < TYPING_THROTTLE_MS) return;
      lastTypingAtRef.current = now;
      onTyping();
    },
    [onChange, onTyping],
  );

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSend();
      }}
      className={`flex items-end gap-2 border-t border-border ${compact ? 'p-2' : 'p-3'}`}
    >
      {/* Sin `disabled` durante el envío: deshabilitar el textarea roba el foco
          tras cada Enter y rompe el tecleo encadenado. El guard de envíos
          concurrentes vive en quien implementa onSend(). */}
      <textarea
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={onKeyDown}
        rows={compact ? 1 : 2}
        maxLength={MESSAGE_MAX_LENGTH}
        placeholder="Escribe un mensaje…"
        className="max-h-40 flex-1 resize-none rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus-visible:border-brand-500 focus-visible:outline-none"
        data-testid="chat-composer-input"
      />
      {compact ? (
        <button
          type="submit"
          disabled={sending || value.trim().length === 0}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-500 text-text-on-brand transition-opacity disabled:opacity-40"
          aria-label="Enviar mensaje"
          data-testid="chat-send"
        >
          <Icon name="arrow-right" size={16} />
        </button>
      ) : (
        <Button
          type="submit"
          disabled={sending || value.trim().length === 0}
          data-testid="chat-send"
        >
          {sending ? 'Enviando…' : 'Enviar'}
        </Button>
      )}
    </form>
  );
}
