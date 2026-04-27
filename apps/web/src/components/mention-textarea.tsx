'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { Textarea } from '@/components/ui/textarea';
import { communityApi } from '@/lib/community';

interface UserMatch {
  userId: string;
  handle: string;
  displayName: string | null;
}

/**
 * Textarea con autocomplete de menciones `@usuario`.
 *
 * Cómo funciona:
 *  - Detecta cuándo el cursor está justo después de `@<prefijo>` (alfanum +
 *    `_.-`) y dispara una búsqueda con debounce 200ms a
 *    `GET /modules/community/users/search?prefix=...`.
 *  - Renderiza un dropdown debajo del cursor con hasta 8 matches.
 *  - Flechas ↑/↓ navegan, Enter / Tab seleccionan, Escape cierra.
 *  - Al seleccionar, reemplaza el `@<prefijo>` por `@<handle> ` y deja el
 *    cursor justo después del espacio.
 *
 * Es deliberadamente standalone (no requiere portal) — usa posicionamiento
 * relativo al wrapper.
 */
export const MentionTextarea = forwardRef<HTMLTextAreaElement, ComponentProps<typeof Textarea>>(
  function MentionTextarea({ value, onChange, ...props }, ref) {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    useImperativeHandle(ref, () => taRef.current!, []);

    const [matches, setMatches] = useState<UserMatch[]>([]);
    const [highlightIdx, setHighlightIdx] = useState(0);
    const [open, setOpen] = useState(false);
    const [activeQuery, setActiveQuery] = useState<{
      prefix: string;
      start: number; // posición del `@` en el value
    } | null>(null);

    // Debounce simple sobre el prefix actual.
    useEffect(() => {
      if (!activeQuery) {
        setMatches([]);
        return;
      }
      const handle = setTimeout(() => {
        void communityApi
          .searchUsers(activeQuery.prefix)
          .then((rows) => {
            setMatches(rows);
            setHighlightIdx(0);
            setOpen(rows.length > 0);
          })
          .catch(() => {
            setMatches([]);
            setOpen(false);
          });
      }, 200);
      return () => clearTimeout(handle);
    }, [activeQuery?.prefix]);

    function detectMention(text: string, caret: number): { prefix: string; start: number } | null {
      if (caret === 0) return null;
      // Buscamos hacia atrás desde el caret hasta el primer `@` o un caracter
      // inválido. Si encontramos `@` con un caracter de borde antes, hay match.
      for (let i = caret - 1; i >= 0; i--) {
        const ch = text[i]!;
        if (ch === '@') {
          const before = i === 0 ? '' : text[i - 1]!;
          const isWordBoundary = i === 0 || /[\s(.,;:!?[\]{}<>]/.test(before);
          if (!isWordBoundary) return null;
          return { prefix: text.slice(i + 1, caret), start: i };
        }
        if (!/[A-Za-z0-9._-]/.test(ch)) return null;
      }
      return null;
    }

    function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      onChange?.(e);
      const ta = e.target;
      const caret = ta.selectionStart ?? 0;
      const m = detectMention(ta.value, caret);
      if (m && m.prefix.length >= 1) {
        setActiveQuery(m);
      } else {
        setActiveQuery(null);
        setOpen(false);
      }
    }

    function selectMatch(idx: number) {
      const ta = taRef.current;
      const q = activeQuery;
      const m = matches[idx];
      if (!ta || !q || !m) return;
      const text = ta.value;
      const caret = ta.selectionStart ?? text.length;
      const before = text.slice(0, q.start);
      const after = text.slice(caret);
      const inserted = `@${m.handle} `;
      const newText = `${before}${inserted}${after}`;
      // Notify parent via synthetic change (uses native setter to bypass React).
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(ta, newText);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const newCaret = before.length + inserted.length;
      queueMicrotask(() => {
        ta.setSelectionRange(newCaret, newCaret);
        ta.focus();
      });
      setOpen(false);
      setActiveQuery(null);
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (!open || matches.length === 0) {
        props.onKeyDown?.(e);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMatch(highlightIdx);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      props.onKeyDown?.(e);
    }

    const dropdownItems = useMemo(() => matches.slice(0, 8), [matches]);

    return (
      <div className="relative">
        <Textarea
          {...props}
          ref={taRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={(e) => {
            // Damos un tick para que el click en el dropdown gane.
            setTimeout(() => setOpen(false), 150);
            props.onBlur?.(e);
          }}
        />
        {open ? (
          <ul
            role="listbox"
            aria-label="Sugerencias de menciones"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-surface shadow-lg"
          >
            {dropdownItems.map((m, idx) => (
              <li
                key={m.userId}
                role="option"
                aria-selected={idx === highlightIdx}
                className={
                  idx === highlightIdx
                    ? 'flex cursor-pointer items-center gap-2 bg-[var(--didacta-info-bg)] px-3 py-2 text-sm text-[var(--didacta-info-fg)]'
                    : 'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-surface-2'
                }
                onMouseEnter={() => setHighlightIdx(idx)}
                onMouseDown={(e) => {
                  // Evita que el blur del textarea cierre el dropdown antes de seleccionar.
                  e.preventDefault();
                  selectMatch(idx);
                }}
              >
                <span className="font-mono font-semibold">@{m.handle}</span>
                {m.displayName ? (
                  <span className="text-xs text-text-subtle">· {m.displayName}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  },
);
