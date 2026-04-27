import Link from 'next/link';
import { type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/icon';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Props {
  label: string;
  value: ReactNode;
  /** Texto auxiliar bajo el número (delta, hint). */
  hint?: ReactNode;
  /** Icono que aparece a la derecha del label, dentro de un chip Azul confianza. */
  icon?: IconName;
  /** Tono del delta — afecta solo al color del hint. */
  tone?: 'success' | 'info' | 'warn' | 'neutral';
  /** Si está presente, la card es clickable y navega. */
  href?: string;
  /** Resalta visualmente la card (ej. items urgentes). */
  highlight?: boolean;
  className?: string;
}

const TONE_CLASS: Record<NonNullable<Props['tone']>, string> = {
  success: 'text-[var(--didacta-success-fg)]',
  info: 'text-[var(--didacta-info-fg)]',
  warn: 'text-[var(--didacta-warn-fg)]',
  neutral: 'text-text-subtle',
};

/**
 * Stat card siguiendo `docs/ui-kit/ui_kits/learn/Primitives.jsx > StatCard`.
 *
 * Especificaciones:
 *  - Padding 20px (`p-5`).
 *  - Label Inter 13/500 color text-muted.
 *  - Number Sora 32/700, line-height 1.1, letter-spacing -0.02em, color text.
 *  - Icon chip 32×32 Azul confianza con bg `--didacta-info-bg` y fg `--didacta-trust`.
 *  - Hint 12/600 color según tone.
 *  - Hover: shadow eleva si la card es clickable (controlado por Card.interactive).
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'success',
  href,
  highlight,
  className,
}: Props) {
  const content = (
    <Card
      interactive={Boolean(href)}
      className={cn(
        'transition-colors',
        highlight ? 'border-warning-200 bg-warning-50/40' : '',
        className,
      )}
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] font-medium leading-tight text-text-muted">{label}</p>
          {icon ? (
            <span
              aria-hidden="true"
              className="grid h-8 w-8 place-items-center rounded-lg"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name={icon} size={18} />
            </span>
          ) : null}
        </div>
        <p
          className="font-display mt-2.5 text-[32px] font-bold leading-[1.1] tracking-tight text-text tabular-nums"
          style={{ letterSpacing: '-0.02em' }}
        >
          {value}
        </p>
        {hint ? (
          <p className={cn('mt-1.5 text-xs font-semibold leading-snug', TONE_CLASS[tone])}>
            {hint}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );

  if (!href) return content;
  return (
    <Link
      href={href as never}
      className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      {content}
    </Link>
  );
}
