'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
          setError(e instanceof ApiHttpError ? e.message : 'Error al cargar tus certificados');
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
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo descargar');
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Mis certificados</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Certificados emitidos al completar tus cursos.
        </p>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {certs === null ? (
        <p className="text-sm text-neutral-500">Cargando…</p>
      ) : certs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-neutral-500">
            Aún no tenés certificados. Completá un curso para obtener uno.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {certs.map((cert) => {
            const courseTitle = cert.snapshot?.courseTitle ?? 'Curso';
            return (
              <Card key={cert.id}>
                <CardHeader>
                  <CardTitle className="text-lg">{courseTitle}</CardTitle>
                  <CardDescription className="font-mono text-xs">{cert.number}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-neutral-500">Emitido el {formatDate(cert.issuedAt)}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDownload(cert)}
                    disabled={downloadingId === cert.id}
                  >
                    {downloadingId === cert.id ? 'Descargando…' : 'Descargar PDF'}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
