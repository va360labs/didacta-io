'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';

/**
 * Lo que ve el ADMINISTRADOR donde iría el tutor IA cuando el aula no tiene
 * proveedor de IA: que está apagado, por qué sus alumnos no lo ven y dónde se
 * enciende. El alumno no ve nada (ni el tutor ni este aviso): un tutor que
 * solo sabe decir «no está indexado, avisa al administrador» es peor que
 * ninguno.
 */
export function AiTutorOffNotice() {
  const t = useTranslations('playersContenido');
  return (
    <div
      className="flex items-start gap-3 rounded-xl border border-dashed border-border-strong bg-surface-2 p-4"
      data-testid="tutor-ia-apagado"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface text-text-muted">
        <Icon name="sparkles" size={18} />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold text-text">{t('aiTutor.offTitle')}</p>
        <p className="text-sm text-text-muted">{t('aiTutor.offBody')}</p>
        <Link
          href="/admin/ai/providers"
          className="inline-block text-sm font-semibold text-brand-700 hover:underline"
        >
          {t('aiTutor.offCta')}
        </Link>
      </div>
    </div>
  );
}
