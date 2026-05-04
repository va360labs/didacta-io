'use client';

import * as React from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { authStorage } from '@/lib/auth-storage';
import { MigratorWizard } from '@/modules/migrator-learndash';

/**
 * Wizard de migración LearnDash → Didacta.
 *
 * Ruta: `/admin/integraciones/migrator-learndash`. Vive dentro del route
 * group `(app)` para heredar:
 *   - El auth guard del layout (sin sesión → redirect a `/signin`).
 *   - El shell admin Didacta (sidebar + chrome).
 *
 * Role-gate adicional: solo `super_admin`. La feature es destructiva
 * (importa miles de filas en BD) y el sidebar ya declara
 * `requiresRole: 'super_admin'`. Acá enforce el mismo gate por si un
 * tenant_admin/formador intenta acceder por URL directa. El backend del
 * módulo aplica su propio gate como defensa final.
 */
export default function MigratorLearndashPage(): React.ReactElement | null {
  const [allowed, setAllowed] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    const session = authStorage.getSession();
    // El layout (app) ya redirige a /signin si no hay sesión; aquí solo
    // resolvemos el rol. Si por alguna race aún no hay session, dejamos
    // null (skeleton) y el layout se encargará.
    if (!session) {
      setAllowed(null);
      return;
    }
    setAllowed(session.user.roles.includes('super_admin'));
  }, []);

  if (allowed === null) return null;

  if (!allowed) {
    return (
      <section className="space-y-6">
        <header>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Migrar desde WordPress + LearnDash
          </h1>
        </header>
        <Card>
          <CardContent className="p-6 space-y-3">
            <p className="text-sm">
              Esta acción solo está disponible para administradores con rol{' '}
              <strong>super_admin</strong>.
            </p>
            <p className="text-sm text-text-muted">
              Si necesitas migrar tu academia LearnDash, contacta con el
              administrador de la instancia.
            </p>
            <div>
              <Button asChild variant="secondary">
                <Link href="/admin">Volver al panel</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Migrar desde WordPress + LearnDash
        </h1>
        <p className="mt-1 text-text-muted">
          Asistente paso a paso para administradores. Tu sitio actual no se
          modifica.
        </p>
      </header>
      <MigratorWizard />
    </section>
  );
}
