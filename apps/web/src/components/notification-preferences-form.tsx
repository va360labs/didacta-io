'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import type {
  NotificationPreference,
  NotificationPrefCategory,
  NotificationPrefChannel,
} from '@/lib/me';

/** Orden de la matriz; el copy vive en `notifCategory*` del catálogo. */
const CATEGORIES: NotificationPrefCategory[] = ['COMMUNITY', 'LEARNING', 'ASSESSMENTS', 'SYSTEM'];

const CHANNELS: NotificationPrefChannel[] = ['EMAIL', 'IN_APP'];

/** Default = activado cuando no hay fila para esa combinación. */
function isEnabled(
  value: NotificationPreference[],
  category: NotificationPrefCategory,
  channel: NotificationPrefChannel,
): boolean {
  const row = value.find((p) => p.category === category && p.channel === channel);
  return row ? row.enabled : true;
}

/**
 * Matriz categoría × canal de preferencias de notificación. Presentacional:
 * el padre maneja la carga (`meApi.getNotificationPreferences`) y el guardado
 * (`meApi.updateNotificationPreferences` + reconciliación del digest community).
 */
export function NotificationMatrix({
  value,
  onChange,
  disabled = false,
}: {
  value: NotificationPreference[];
  onChange: (next: NotificationPreference[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('cuentaComponentes');

  function toggle(category: NotificationPrefCategory, channel: NotificationPrefChannel) {
    const next = !isEnabled(value, category, channel);
    const without = value.filter((p) => !(p.category === category && p.channel === channel));
    onChange([...without, { category, channel, enabled: next }]);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-soft">
      <div className="grid grid-cols-[1fr_5.5rem_5.5rem] items-center border-b border-border-soft bg-surface-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
        <span>{t('notif.categoryHeader')}</span>
        {CHANNELS.map((ch) => (
          <span key={ch} className="text-center">
            {t(`notifChannel.${ch}`)}
          </span>
        ))}
      </div>
      {CATEGORIES.map((cat) => (
        <div
          key={cat}
          className="grid grid-cols-[1fr_5.5rem_5.5rem] items-center border-b border-border-soft px-4 py-3 last:border-b-0"
        >
          <div className="pr-3">
            <p className="font-medium text-text">{t(`notifCategory.${cat}`)}</p>
            <p className="text-sm text-text-muted">{t(`notifCategoryDesc.${cat}`)}</p>
          </div>
          {CHANNELS.map((ch) => (
            <label key={ch} className="flex cursor-pointer justify-center">
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer rounded border-border-strong"
                checked={isEnabled(value, cat, ch)}
                disabled={disabled}
                onChange={() => toggle(cat, ch)}
                aria-label={t('notif.toggleAria', {
                  category: t(`notifCategory.${cat}`),
                  channel: t(`notifChannel.${ch}`),
                })}
              />
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Construye la matriz completa (8 celdas) a partir de un set parcial de
 * preferencias, rellenando con `true` lo que falte. Útil para inicializar el
 * estado del formulario garantizando que el PUT envía todas las combinaciones.
 */
export function fullMatrix(partial: NotificationPreference[]): NotificationPreference[] {
  const out: NotificationPreference[] = [];
  for (const cat of CATEGORIES) {
    for (const ch of CHANNELS) {
      out.push({
        category: cat,
        channel: ch,
        enabled: isEnabled(partial, cat, ch),
      });
    }
  }
  return out;
}
