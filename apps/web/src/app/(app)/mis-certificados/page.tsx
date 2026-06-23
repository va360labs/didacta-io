'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { certificatesApi, type Certificate } from '@/modules/certificates';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-ES', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function MisCertificadosPage() {
  const [certs, setCerts] = useState<Certificate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    void certificatesApi
      .listMine()
      .then((data) => {
        if (!aborted) setCerts(data);
      })
      .catch((e) => {
        if (!aborted)
          setError(
            e instanceof ApiHttpError
              ? e.message
              : 'No pudimos cargar tus certificados. Prueba refrescar la página.',
          );
      });
    return () => {
      aborted = true;
    };
  }, []);

  async function handleDownload(cert: Certificate) {
    setDownloadingId(cert.id);
    setError(null);
    try {
      await certificatesApi.openInNewTab(cert.id, `${cert.number}.pdf`);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos descargar el PDF.');
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <section className="space-y-8">
      <header>
        <h1
          className="font-display text-2xl font-bold tracking-tight text-text"
          style={{ letterSpacing: '-0.02em' }}
        >
          Mis certificados
        </h1>
        <p className="mt-2 max-w-2xl text-text-muted">
          Cada vez que completas un curso, generamos un certificado nominal con número correlativo y
          hash de verificación.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {certs === null ? (
        <div className="grid gap-5 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton h-48 w-full" />
          ))}
        </div>
      ) : certs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              aria-hidden="true"
              className="flex h-20 w-20 items-center justify-center rounded-2xl"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="award" size={40} />
            </div>
            <h3 className="font-display text-2xl font-semibold">Aún no tienes certificados</h3>
            <p className="max-w-md text-text-muted">
              Cuando completes tu primer curso, vas a verlo acá listo para descargar y compartir.
            </p>
            <Button asChild className="mt-2">
              <Link href="/cursos">Ver el catálogo</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {certs.map((cert) => {
            const courseTitle = cert.snapshot?.courseTitle ?? 'Curso';
            return (
              <Card key={cert.id} className="flex h-full flex-col overflow-hidden p-0">
                {/* Cover institucional Azul noche con award icon prominente */}
                <div
                  className="relative flex flex-col items-center justify-center px-6 py-8 text-white"
                  style={{
                    background: 'linear-gradient(135deg, #0D1B2A 0%, #1E5AA8 100%)',
                  }}
                >
                  {/* Book motif sutil */}
                  <svg
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-12 w-full opacity-25"
                    viewBox="0 0 200 60"
                    preserveAspectRatio="none"
                  >
                    <path d="M0 40 Q100 0 200 40 L200 60 L0 60 Z" fill="rgba(255,255,255,.18)" />
                    <path
                      d="M0 50 Q100 10 200 50"
                      stroke="rgba(255,255,255,.4)"
                      strokeWidth="1.5"
                      fill="none"
                    />
                  </svg>

                  <div className="relative z-10 flex flex-col items-center gap-2">
                    <div
                      aria-hidden="true"
                      className="grid h-12 w-12 place-items-center rounded-full bg-white/15 text-white"
                    >
                      <Icon name="award" size={28} />
                    </div>
                    <p className="label-uppercase text-white/70">Certificado de finalización</p>
                    <p className="font-display text-2xl font-bold tabular-nums">{cert.number}</p>
                  </div>
                </div>

                <CardContent className="flex flex-1 flex-col gap-4 p-6">
                  <div>
                    <h3
                      className="font-display text-xl font-bold leading-tight text-text"
                      style={{ letterSpacing: '-0.01em' }}
                    >
                      {courseTitle}
                    </h3>
                    <p className="mt-1.5 text-sm text-text-subtle">
                      Emitido el {formatDate(cert.issuedAt)}
                    </p>
                  </div>
                  <div className="mt-auto flex items-center gap-2">
                    <Button
                      onClick={() => handleDownload(cert)}
                      disabled={downloadingId === cert.id}
                    >
                      <Icon name="award" size={16} />
                      {downloadingId === cert.id ? 'Descargando…' : 'Descargar PDF'}
                    </Button>
                    <Badge variant="premium" dot className="ml-auto">
                      Verificado
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
