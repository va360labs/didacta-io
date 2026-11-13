'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { CommunityFeed } from '@/components/community-feed';
import { GettingStartedChecklist } from '@/components/getting-started-checklist';
import { useSimpleMode } from '@/lib/simple-mode';

export default function ComunidadPage() {
  // Modo sencillo: la lista de pasos vive en «Empieza aquí», no encima del feed.
  const simple = useSimpleMode() === true;
  return (
    <div className="space-y-4">
      {/* Solo admins con el asistente completado y pasos pendientes; para el
          resto rinde null y el feed queda como estaba. `/inicio` redirige
          aquí: este es el aterrizaje real del panel. */}
      {simple ? null : <GettingStartedChecklist />}
      <CommunityFeed simple={simple} />
    </div>
  );
}
