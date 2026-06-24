'use client';

import type {
  NotificationPreference,
  NotificationPrefCategory,
  NotificationPrefChannel,
} from '@/lib/me';

const CATEGORIES: { key: NotificationPrefCategory; label: string; desc: string }[] = [
  { key: 'COMMUNITY', label: 'Comunidad', desc: 'Menciones, respuestas y resumen semanal.' },
  {
    key: 'LEARNING',
    label: 'Aprendizaje',
    desc: 'Matrículas, cursos completados y certificados.',
  },
  { key: 'ASSESSMENTS', label: 'Evaluaciones', desc: 'Resultados de tus cuestionarios.' },
  { key: 'SYSTEM', label: 'Sistema', desc: 'Avisos administrativos y de la plataforma.' },
];

const CHANNELS: { key: NotificationPrefChannel; label: string }[] = [
  { key: 'EMAIL', label: 'Email' },
  { key: 'IN_APP', label: 'En la app' },
];

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
  function toggle(category: NotificationPrefCategory, channel: NotificationPrefChannel) {
    const next = !isEnabled(value, category, channel);
    const without = value.filter((p) => !(p.category === category && p.channel === channel));
    onChange([...without, { category, channel, enabled: next }]);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-soft">
      <div className="grid grid-cols-[1fr_5.5rem_5.5rem] items-center border-b border-border-soft bg-surface-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
        <span>Categoría</span>
        {CHANNELS.map((c) => (
          <span key={c.key} className="text-center">
            {c.label}
          </span>
        ))}
      </div>
      {CATEGORIES.map((cat) => (
        <div
          key={cat.key}
          className="grid grid-cols-[1fr_5.5rem_5.5rem] items-center border-b border-border-soft px-4 py-3 last:border-b-0"
        >
          <div className="pr-3">
            <p className="font-medium text-text">{cat.label}</p>
            <p className="text-sm text-text-muted">{cat.desc}</p>
          </div>
          {CHANNELS.map((ch) => (
            <label key={ch.key} className="flex cursor-pointer justify-center">
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer rounded border-border-strong"
                checked={isEnabled(value, cat.key, ch.key)}
                disabled={disabled}
                onChange={() => toggle(cat.key, ch.key)}
                aria-label={`${cat.label} por ${ch.label}`}
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
        category: cat.key,
        channel: ch.key,
        enabled: isEnabled(partial, cat.key, ch.key),
      });
    }
  }
  return out;
}
