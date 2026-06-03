'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { adminTenantsApi } from '@/lib/admin-tenants';
import { authStorage } from '@/lib/auth-storage';

export default function NuevoTenantPage() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [primaryHostname, setPrimaryHostname] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const token = authStorage.getAccessToken();
    if (!token) {
      setError('Tu sesión expiró.');
      setPending(false);
      return;
    }
    try {
      const created = await adminTenantsApi.create(token, {
        slug: slug.trim(),
        name: name.trim(),
        adminEmail: adminEmail.trim(),
        adminName: adminName.trim() || undefined,
        primaryHostname: primaryHostname.trim().toLowerCase(),
      });
      router.push(`/admin/tenants/${created.id}` as never);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos crear el tenant.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href="/admin/tenants">← Volver al listado</Link>
      </Button>

      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Crear tenant</h1>
        <p className="mt-1 text-text-muted">
          Configura una nueva organización con su primer admin y un dominio primario.
        </p>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="building" size={18} />
            </span>
            <div className="min-w-0">
              <CardTitle>Datos de la organización</CardTitle>
              <CardDescription>
                Tras crearla, el primer admin recibirá un email con un enlace para definir su
                contraseña y acceder.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="slug">
                  Slug <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  placeholder="acme"
                  required
                  pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
                  className="font-mono"
                />
                <p className="text-xs text-text-subtle">
                  Solo minúsculas, números y guiones. Sin espacios.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="name">
                  Nombre legible <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ACME Corp"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="primaryHostname">
                Dominio primario <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="primaryHostname"
                value={primaryHostname}
                onChange={(e) => setPrimaryHostname(e.target.value.toLowerCase())}
                placeholder="aprende.acme.com"
                required
                className="font-mono"
              />
              <p className="text-xs text-text-subtle">
                Donde estarán signin y signup. Puede ser un subdominio de Didacta o un dominio
                custom (en ese caso configura el CNAME por afuera).
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="adminEmail">
                  Email del primer admin <span className="text-danger-700">*</span>
                </Label>
                <Input
                  id="adminEmail"
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adminName">Nombre del admin (opcional)</Label>
                <Input
                  id="adminName"
                  value={adminName}
                  onChange={(e) => setAdminName(e.target.value)}
                />
              </div>
            </div>

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
              >
                {error}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-3 border-t border-border-soft pt-4">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                Cancelar
              </Button>
              <Button type="submit" disabled={pending} size="lg">
                {pending ? 'Creando…' : 'Crear tenant'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
