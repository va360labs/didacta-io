'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * "Añadir al calendario" de una clase en directo.
 *
 * Los cuatro destinos son endpoints públicos de la API
 * (`/api/v1/modules/zoom-live/sessions/<id>/calendar/*`): tres redirigen al
 * proveedor con el evento ya montado y el cuarto descarga el `.ics`. La URL
 * se construye en el servidor, así que el email de confirmación y esta
 * pantalla generan exactamente el mismo evento — nada que mantener por
 * duplicado en el cliente.
 *
 * Ninguno lleva el `joinUrl` de Zoom: el evento apunta a `/clase/<id>` y es
 * esa página la que decide si enseñarlo (gating server-side, ADR-017).
 */

import { Icon } from '@/components/icon';
import { Dialog } from '@/components/ui/dialog';

interface CalendarTarget {
  key: string;
  label: string;
  hint: string;
  /** El `.ics` se descarga; los demás abren el proveedor en otra pestaña. */
  download?: boolean;
}

const TARGETS: CalendarTarget[] = [
  { key: 'google', label: 'Google Calendar', hint: 'Cuentas de Gmail y Workspace' },
  { key: 'outlook', label: 'Outlook.com', hint: 'Cuentas personales de Outlook o Hotmail' },
  { key: 'office365', label: 'Outlook (Microsoft 365)', hint: 'Cuentas de trabajo o del centro' },
  {
    key: 'calendar.ics',
    label: 'Apple Calendar y otros',
    hint: 'Descarga el evento .ics y ábrelo con tu calendario',
    download: true,
  },
];

function hrefFor(sessionId: string, target: CalendarTarget): string {
  return target.download
    ? `/api/v1/modules/zoom-live/sessions/${sessionId}/calendar.ics`
    : `/api/v1/modules/zoom-live/sessions/${sessionId}/calendar/${target.key}`;
}

export interface AddToCalendarDialogProps {
  sessionId: string;
  topic: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Copy de cabecera: cambia si venimos de inscribirnos o del botón suelto. */
  justRegistered?: boolean;
}

export function AddToCalendarDialog({
  sessionId,
  topic,
  open,
  onOpenChange,
  justRegistered = false,
}: AddToCalendarDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={justRegistered ? '¡Estás dentro!' : 'Añadir al calendario'}
      description={
        justRegistered
          ? `Te has inscrito a "${topic}". Guárdala en tu calendario para que no se te pase.`
          : `Guarda "${topic}" en tu calendario.`
      }
      maxWidthClass="max-w-md"
    >
      <div data-testid="add-to-calendar" className="space-y-2">
        {TARGETS.map((target) => (
          <a
            key={target.key}
            href={hrefFor(sessionId, target)}
            data-testid={`calendar-${target.key}`}
            {...(target.download
              ? { download: `clase-${sessionId}.ics` }
              : { target: '_blank', rel: 'noreferrer' })}
            className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-bg-subtle"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-bg-subtle text-text-muted">
              <Icon name={target.download ? 'download-cloud' : 'calendar'} size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-text">{target.label}</span>
              <span className="block text-xs text-text-muted">{target.hint}</span>
            </span>
          </a>
        ))}
      </div>

      <p className="mt-4 text-xs text-text-subtle">
        Te avisaremos también por email 2 horas antes de empezar.
      </p>
    </Dialog>
  );
}
