'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { adminUsersApi, ROLE_LABELS, type AssignableRole } from '@/lib/admin-users';
import { authStorage } from '@/lib/auth-storage';

export default function InvitarPage() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AssignableRole>('alumno');

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
      await adminUsersApi.invite(token, {
        email: email.trim(),
        name: name.trim() || undefined,
        role,
      });
      router.push('/admin/usuarios');
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos enviar la invitación.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Invitar persona</h1>
        <p className="mt-1 text-text-muted">
          Le enviaremos un email con un enlace para que defina su contraseña y entre.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Datos del nuevo usuario</CardTitle>
          <CardDescription>
            El email tiene que ser único en tu organización. El rol se puede cambiar después.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">
                Email <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="persona@empresa.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Nombre completo (opcional)</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="María Pérez"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">
                Rol inicial <span className="text-danger-700">*</span>
              </Label>
              <Select
                id="role"
                value={role}
                onChange={(e) => setRole(e.target.value as AssignableRole)}
              >
                {Object.entries(ROLE_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-text-subtle">
                {role === 'tenant_admin' &&
                  'Los administradores tienen acceso completo al panel y deberán activar MFA.'}
                {role === 'formador' &&
                  'Los formadores pueden crear y gestionar cursos, quizzes y correcciones.'}
                {role === 'alumno' &&
                  'Los alumnos consumen los cursos publicados de la organización.'}
                {role === 'auditor' && 'Los auditores pueden consultar el log y certificados.'}
                {role === 'empresa_manager' &&
                  'Los gerentes ven analytics y miembros de su empresa.'}
              </p>
            </div>

            {error ? (
              <p role="alert" className="text-sm text-danger-700">
                {error}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                Cancelar
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Enviando…' : 'Enviar invitación'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
