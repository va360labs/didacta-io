'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { labelOr } from '@/lib/i18n/labels';
import type { CourseStatus } from '@/lib/courses';

export function CourseStatusBadge({ status }: { status: CourseStatus }) {
  const t = useTranslations('playersContenido');
  // El estado llega de la API: si algún día aparece uno nuevo, se muestra el
  // valor crudo antes que una key del catálogo.
  const label = labelOr(t, `courseStatus.${status}`, status);

  if (status === 'PUBLISHED') return <Badge variant="success">{label}</Badge>;
  if (status === 'ARCHIVED') return <Badge variant="muted">{label}</Badge>;
  return <Badge variant="warning">{label}</Badge>;
}
