'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { CommunityAvatar } from '@/components/community-avatar';
import { Icon } from '@/components/icon';
import { SpaceIcon } from '@/components/space-icon';
import type { ConversationView } from './client';

/**
 * Distintivo de una conversación, compartido por `/mensajes` y el chat flotante.
 *
 * Salas → cuadro redondeado con el icono y color REALES del espacio (los que el
 * operador configuró en mod.community). El mockup dibujaba un `#` genérico: se
 * descartó porque tiraba información real por decoración. La forma —cuadro para
 * sala, círculo para persona— es lo que distingue una de otra de un vistazo.
 */
export function ConversationBadge({
  conv,
  size,
  online = false,
}: {
  conv: ConversationView;
  size: number;
  /** Punto verde de presencia (solo tiene sentido en conversaciones con persona). */
  online?: boolean;
}) {
  const t = useTranslations('modMessaging');

  if (conv.type === 'SPACE' && conv.space) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-lg border border-border-soft bg-bg-subtle"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <SpaceIcon icon={conv.space.icon} color={conv.space.color} size={Math.round(size * 0.55)} />
      </span>
    );
  }

  if (conv.counterpart) {
    return (
      <span className="relative shrink-0" style={{ width: size, height: size }}>
        <CommunityAvatar
          userId={conv.counterpart.id}
          name={conv.counterpart.name}
          avatarUrl={conv.counterpart.avatarUrl}
          size={size}
          // El badge vive dentro de un <button>: un link anidado navegaría al
          // perfil en vez de abrir la conversación.
          linkToProfile={false}
        />
        {online ? (
          <span
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-success-500"
            aria-label={t('presenceOnline')}
            data-testid="presence-dot"
          />
        ) : null}
      </span>
    );
  }

  // Canal "Profesores" del alumno: icono de equipo docente.
  return (
    <span
      className="grid shrink-0 place-items-center rounded-lg bg-bg-subtle text-text-muted"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Icon name="users" size={Math.round(size * 0.5)} />
    </span>
  );
}
