'use client';

import Link from 'next/link';
import { Icon, type IconName } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useCourseCategories } from '@/lib/course-categories';
import { formatDuration } from '@/lib/format';
import { richHtmlToPlainText } from '@/lib/sanitize-html';
import { cn } from '@/lib/utils';

export interface CourseCardData {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  estimatedMinutes: number | null;
  language: string;
  thumbnailUrl: string | null;
  /** Progreso 0..100 si el alumno ya está matriculado, null si no. */
  progressPercent?: number | null;
  /** Estado del enrollment para mostrar el chip correcto. */
  status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | null;
}

interface Props {
  course: CourseCardData;
  /** Si quieres un href custom (ej. detalle de formador). Default: /cursos/{slug}. */
  href?: string;
}

const COVER_GRADIENTS = [
  'linear-gradient(135deg, #0D1B2A 0%, #1E5AA8 100%)',
  'linear-gradient(135deg, #18B5A8 0%, #2E7DCE 100%)',
  'linear-gradient(135deg, #1E5AA8 0%, #2E7DCE 100%)',
  'linear-gradient(135deg, #2E7DCE 0%, #18B5A8 100%)',
];

function pickGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return COVER_GRADIENTS[hash % COVER_GRADIENTS.length]!;
}

/**
 * Card de curso siguiendo `docs/ui-kit/ui_kits/learn/CourseCard.jsx`.
 *
 * Estructura:
 *  - Cover 110px con gradient Didacta + book motif sutil + badge de estado
 *    (en curso / completado / pendiente) sobre el cover.
 *  - Body con categoría · nivel, título Sora 18/700, meta (módulos · horas),
 *    progress bar 8px, footer con % completado + CTA contextual
 *    (Continuar / Certificado / Empezar).
 */
export function CourseCard({ course, href }: Props) {
  const target = href ?? (`/cursos/${course.slug}` as const);
  const status = resolveStatus(course);
  const cover = course.thumbnailUrl ? null : pickGradient(course.slug || course.id || course.title);
  const progress = typeof course.progressPercent === 'number' ? course.progressPercent : null;
  const categoriesByName = useCourseCategories();
  const curatedCategory = course.category ? categoriesByName.get(course.category) : undefined;
  const ctaTone = status === 'completed' ? 'success' : 'info';
  const ctaLabel =
    status === 'completed'
      ? 'Certificado'
      : progress != null && progress > 0
        ? 'Continuar'
        : 'Empezar';
  const ctaIcon = status === 'completed' ? 'award' : 'arrow-right';

  return (
    <Link
      href={target as never}
      className="group block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <Card interactive className="flex h-full flex-col overflow-hidden p-0">
        {/* Cover */}
        <div
          className="relative flex h-[110px] items-end p-3.5"
          style={{
            background: cover ?? `url(${course.thumbnailUrl ?? ''}) center/cover`,
          }}
        >
          {/* Book motif sutil — replica el SVG del UI kit. */}
          {cover ? (
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-2.5 -right-2.5 opacity-[0.18]"
              width="120"
              height="80"
              viewBox="0 0 120 80"
              fill="none"
              stroke="#fff"
              strokeWidth="2"
            >
              <path d="M10 60 Q60 30 110 60 L110 70 Q60 40 10 70 Z" />
              <path d="M10 50 Q60 20 110 50" />
            </svg>
          ) : null}
        </div>

        {/* Body */}
        <CardContent className="flex flex-1 flex-col gap-2.5 p-5">
          {/* Meta: estado (siempre) + categoría (si la hay). El badge de estado
              vivía sobre la imagen; lo movimos aquí para no taparla. */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-text-muted">
            <Badge
              variant={
                status === 'completed' ? 'success' : status === 'pending' ? 'warning' : 'info'
              }
              dot
            >
              {status === 'completed'
                ? 'Completado'
                : status === 'pending'
                  ? 'Pendiente'
                  : 'En curso'}
            </Badge>
            {course.category ? (
              curatedCategory ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{
                    backgroundColor: `${curatedCategory.color}2E`,
                    color: curatedCategory.color,
                  }}
                >
                  {curatedCategory.icon ? (
                    <Icon name={curatedCategory.icon as IconName} size={12} />
                  ) : null}
                  {curatedCategory.name}
                </span>
              ) : (
                <span>{course.category}</span>
              )
            ) : null}
          </div>

          <h3
            className="font-display text-lg font-bold leading-tight text-text group-hover:text-brand-700"
            style={{ letterSpacing: '-0.01em' }}
          >
            {course.title}
          </h3>

          {course.description ? (
            <p className="line-clamp-2 text-sm leading-snug text-text-muted">
              {richHtmlToPlainText(course.description)}
            </p>
          ) : null}

          <div className="mt-auto space-y-3">
            {course.estimatedMinutes ? (
              <div className="text-xs font-medium text-text-subtle tabular-nums">
                ≈ {formatDuration(course.estimatedMinutes)}
              </div>
            ) : null}

            {progress != null ? (
              <Progress
                value={progress}
                tone={status === 'completed' ? 'success' : 'info'}
                label={`Progreso ${Math.round(progress)}%`}
              />
            ) : null}

            <div className="flex items-center justify-between gap-2 pt-1">
              <span
                className={cn(
                  'text-[13px] font-semibold tabular-nums',
                  status === 'completed' ? 'text-[var(--didacta-success-fg)]' : 'text-text',
                )}
              >
                {progress != null ? `${Math.round(progress)}% completado` : 'Sin matricular'}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 text-xs font-semibold',
                  ctaTone === 'success'
                    ? 'text-[var(--didacta-success-fg)]'
                    : 'text-[var(--didacta-info-fg)]',
                )}
              >
                {ctaLabel}
                <Icon name={ctaIcon} size={14} />
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function resolveStatus(course: CourseCardData): 'completed' | 'in-progress' | 'pending' {
  if (course.status === 'COMPLETED') return 'completed';
  const p = course.progressPercent ?? null;
  if (p !== null && p > 0) return 'in-progress';
  return 'pending';
}
