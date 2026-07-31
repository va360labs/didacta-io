'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { useTenantDisplayName } from '@/lib/tenant-context';
import { certificatesApi, type PublicCertificateView } from '@/modules/certificates';

type State = 'loading' | 'ok' | 'notfound' | 'error';

/**
 * Página PÚBLICA de verificación de un certificado (sin sesión). Es la URL que
 * se comparte / que LinkedIn referencia. Muestra solo datos no sensibles.
 */
export default function VerifyCertificatePage() {
  const params = useParams<{ id: string }>();
  // La API pública no devuelve el emisor: usamos el nombre del tenant resuelto
  // por host (misma resolución que el resto de pantallas sin sesión).
  const tenantName = useTenantDisplayName();
  const [cert, setCert] = useState<PublicCertificateView | null>(null);
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    if (!params?.id) return;
    let cancelled = false;
    certificatesApi
      .verifyPublic(params.id)
      .then((c) => {
        if (cancelled) return;
        setCert(c);
        setState('ok');
      })
      .catch((e) => {
        if (cancelled) return;
        setState(e instanceof ApiHttpError && e.status === 404 ? 'notfound' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [params?.id]);

  return (
    <div className="relative z-10 w-full max-w-lg">
      <Card className="overflow-hidden">
        <CardContent className="space-y-6 p-8 text-center">
          {state === 'loading' ? (
            <div className="space-y-4">
              <div className="skeleton mx-auto h-16 w-16 rounded-full" />
              <div className="skeleton mx-auto h-6 w-2/3" />
              <div className="skeleton mx-auto h-4 w-1/2" />
            </div>
          ) : state === 'notfound' ? (
            <>
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-danger-50 text-danger-700">
                <Icon name="shield" size={32} />
              </div>
              <div>
                <h1 className="font-display text-xl font-bold text-text">
                  Certificado no encontrado
                </h1>
                <p className="mt-1 text-sm text-text-muted">
                  No existe ningún certificado con ese identificador. Comprueba el enlace.
                </p>
              </div>
            </>
          ) : state === 'error' ? (
            <>
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-warning-50 text-warning-700">
                <Icon name="shield" size={32} />
              </div>
              <div>
                <h1 className="font-display text-xl font-bold text-text">
                  No pudimos verificar ahora
                </h1>
                <p className="mt-1 text-sm text-text-muted">Inténtalo de nuevo en unos minutos.</p>
              </div>
            </>
          ) : cert ? (
            <>
              <div
                className={`mx-auto grid h-16 w-16 place-items-center rounded-full ${
                  cert.valid
                    ? 'bg-[var(--didacta-success-bg)] text-[var(--didacta-success-fg)]'
                    : 'bg-danger-50 text-danger-700'
                }`}
              >
                <Icon name={cert.valid ? 'check' : 'shield'} size={32} />
              </div>
              <div className="space-y-1">
                {cert.valid ? (
                  <Badge variant="success" dot>
                    Certificado verificado
                  </Badge>
                ) : (
                  <Badge variant="danger" dot>
                    Certificado revocado
                  </Badge>
                )}
                <h1 className="font-display text-2xl font-bold text-text">{cert.studentName}</h1>
                <p className="text-text-muted">
                  ha completado el curso <strong className="text-text">{cert.courseTitle}</strong>
                </p>
              </div>
              <dl className="mx-auto grid max-w-xs grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 text-left text-sm">
                <dt className="text-text-subtle">Fecha de emisión</dt>
                <dd className="text-right font-medium text-text tabular-nums">
                  {formatDate(cert.issuedAt)}
                </dd>
                <dt className="text-text-subtle">Nº de certificado</dt>
                <dd className="text-right font-mono text-text">{cert.number}</dd>
              </dl>
              <p className="text-xs text-text-subtle">Verificado por {tenantName}</p>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}
