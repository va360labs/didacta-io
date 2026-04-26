'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { certificatesApi, type Certificate } from '@/lib/certificates';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-AR', {
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
              : 'No pudimos cargar tus certificados. Probá refrescar la página.',
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
        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text">
          Mis certificados
        </h1>
        <p className="mt-2 max-w-2xl text-text-muted">
          Cada vez que completás un curso, generamos un certificado nominal con número correlativo y
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
              className="flex h-20 w-20 items-center justify-center rounded-full bg-brand-50 text-brand-700 text-3xl"
              aria-hidden="true"
            >
              🎓
            </div>
            <h3 className="font-display text-2xl font-semibold">Aún no tenés certificados</h3>
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
              <Card key={cert.id} className="flex h-full flex-col overflow-hidden">
                <div
                  className="flex items-center justify-center px-6 py-8 text-text-on-brand"
                  style={{
                    background: `linear-gradient(135deg, hsl(var(--brand-h) 80% 22%), hsl(var(--brand-h) 70% 45%))`,
                  }}
                >
                  <div className="text-center">
                    <p className="label-uppercase opacity-80">Certificado de finalización</p>
                    <p className="mt-2 font-mono text-lg font-semibold tabular-nums">
                      {cert.number}
                    </p>
                  </div>
                </div>
                <CardContent className="flex flex-1 flex-col gap-4 p-6">
                  <div>
                    <h3 className="font-display text-xl font-bold leading-tight text-text">
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
                      {downloadingId === cert.id ? 'Descargando…' : 'Descargar PDF'}
                    </Button>
                    <Badge variant="success" className="ml-auto">
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
