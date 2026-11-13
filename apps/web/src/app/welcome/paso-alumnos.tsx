'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { adminUsersApi } from '@/lib/admin-users';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Tope prudente para el asistente. Una tanda corta se envía en segundos y se
 * puede enseñar resultado a resultado; una lista de cientos pertenece a la
 * importación por CSV, que ya existe y es reanudable.
 */
const MAX_TANDA = 20;

type Resultado = 'ok' | 'existe' | 'error';

interface Props {
  /** Avisa al pie: con al menos una invitación resuelta, el paso está hecho. */
  onHecho: (hecho: boolean) => void;
}

/**
 * Paso «alumnos»: las invitaciones se envían AQUÍ, no en otra pestaña.
 *
 * Envío secuencial a propósito: cada correo crea un usuario y dispara un email,
 * y hacerlo de uno en uno permite contar el progreso y dar resultado por
 * dirección (enviada / ya estaba / falló) en vez de un «algo fue mal» global.
 */
export function PasoAlumnos({ onHecho }: Props) {
  const t = useTranslations('bienvenida');
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [hechas, setHechas] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [resultados, setResultados] = useState<Array<{ email: string; resultado: Resultado }>>([]);

  async function enviar() {
    setError(null);
    const correos = [
      ...new Set(
        texto
          .split(/[\n,;]+/)
          .map((l) => l.trim())
          .filter((l) => EMAIL_RE.test(l)),
      ),
    ];
    if (correos.length === 0) {
      setError(t('alumnosVacio'));
      return;
    }
    if (correos.length > MAX_TANDA) {
      setError(t('alumnosMax', { max: MAX_TANDA }));
      return;
    }
    const token = authStorage.getAccessToken();
    if (!token) return;
    setEnviando(true);
    setTotal(correos.length);
    setHechas(0);
    const nuevos: Array<{ email: string; resultado: Resultado }> = [];
    for (const email of correos) {
      try {
        await adminUsersApi.invite(token, { email, role: 'alumno' });
        nuevos.push({ email, resultado: 'ok' });
      } catch (e) {
        const existe = e instanceof ApiHttpError && e.code === 'ADMIN_USER_EMAIL_EXISTS';
        nuevos.push({ email, resultado: existe ? 'existe' : 'error' });
      }
      setHechas((n) => n + 1);
      setResultados([...nuevos]);
    }
    setEnviando(false);
    setTexto('');
    // «Ya estaba» también resuelve el paso: ese alumno ya tiene acceso.
    if (nuevos.some((r) => r.resultado !== 'error')) onHecho(true);
  }

  const enviadas = resultados.filter((r) => r.resultado === 'ok').length;

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('alumnosTitulo')}</h1>
        <p className="text-text-muted">{t('alumnosCuerpo')}</p>
      </header>

      <div className="space-y-2">
        <Label htmlFor="correos-alumnos">{t('alumnosEtiqueta')}</Label>
        <textarea
          id="correos-alumnos"
          value={texto}
          rows={5}
          placeholder={t('alumnosPlaceholder')}
          onChange={(e) => setTexto(e.target.value)}
          disabled={enviando}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 disabled:opacity-60"
        />
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-danger-700">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <Button type="button" onClick={() => void enviar()} disabled={enviando}>
        {enviando ? t('alumnosEnviando', { hechas, total }) : t('alumnosEnviar')}
      </Button>

      {resultados.length > 0 && (
        <div className="space-y-2">
          {enviadas > 0 && !enviando && (
            <p className="flex items-center gap-1.5 text-sm font-medium text-success-700">
              <Icon name="check" size={16} />
              {t('alumnosEnviadas', { n: enviadas })}
            </p>
          )}
          <ul className="divide-y divide-border-soft overflow-hidden rounded-lg border border-border">
            {resultados.map(({ email, resultado }) => (
              <li
                key={email}
                className="flex items-center justify-between gap-3 bg-surface px-3 py-2 text-sm"
              >
                <span className="truncate">{email}</span>
                {resultado === 'ok' && (
                  <span className="flex shrink-0 items-center gap-1 text-success-700">
                    <Icon name="check" size={14} />
                    {t('alumnosResultadoOk')}
                  </span>
                )}
                {resultado === 'existe' && (
                  <span className="shrink-0 text-text-subtle">{t('alumnosResultadoExiste')}</span>
                )}
                {resultado === 'error' && (
                  <span className="flex shrink-0 items-center gap-1 text-danger-700">
                    <Icon name="alert" size={14} />
                    {t('alumnosResultadoError')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-text-subtle">{t('alumnosDespues')}</p>
    </div>
  );
}
