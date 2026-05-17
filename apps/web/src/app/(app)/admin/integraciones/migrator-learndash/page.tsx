'use client';

import * as React from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { authStorage } from '@/lib/auth-storage';
import { loadModuleUI, ModuleUINotFoundError, type LoadedModuleUI } from '@/lib/module-loader';

/**
 * Página host para el surface admin del módulo migrator-learndash.
 *
 * Ruta: `/admin/integraciones/migrator-learndash`. Vive dentro del route
 * group `(app)` para heredar:
 *   - El auth guard del layout (sin sesión → redirect a `/signin`).
 *   - El shell admin Didacta (sidebar + chrome).
 *
 * alpha.60 (ADR-015): esta page NO importa código del módulo. Solo:
 *   1. Enforce role-gate (`super_admin`).
 *   2. Llama `loadModuleUI('mod.migrator-learndash', 'admin')` que hace
 *      fetch del bundle `dist/ui/admin.js` del ZIP firmado.
 *   3. Renderiza el componente default que el bundle exporta.
 *
 * Antes de alpha.60 esta page importaba `MigratorWizard` directamente desde
 * `apps/web/src/modules/migrator-learndash/`. Eso violaba ADR-015: la UI
 * del módulo debe vivir DENTRO del módulo, no en el árbol del host.
 *
 * TODO Sprint 5: convertir esta page en `[slug]/page.tsx` parametrizada, una
 * sola ruta genérica que sirva para cualquier módulo con surface 'admin'.
 * Esto cierra el último hilo de hardcode módulo-en-host.
 */
export default function MigratorLearndashPage(): React.ReactElement | null {
  const [allowed, setAllowed] = React.useState<boolean | null>(null);
  const [loaded, setLoaded] = React.useState<LoadedModuleUI | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const session = authStorage.getSession();
    if (!session) {
      setAllowed(null);
      return;
    }
    setAllowed(session.user.roles.includes('super_admin'));
  }, []);

  React.useEffect(() => {
    if (allowed !== true) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await loadModuleUI('mod.migrator-learndash', 'admin');
        if (!cancelled) setLoaded(result);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof ModuleUINotFoundError ? 'MODULE_UI_NOT_FOUND' : 'MODULE_UI_LOAD_ERROR';
        setLoadError(`${code}: ${msg}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed]);

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
      {loadError && (
        <Card>
          <CardContent className="p-6 space-y-3">
            <p className="text-sm text-destructive">
              No se pudo cargar la UI del módulo: {loadError}
            </p>
            <p className="text-xs text-text-muted">
              Verificá que el módulo <code>mod.migrator-learndash</code> esté instalado
              en una versión que incluya el surface admin (1.0.15+). Subí el
              ZIP actualizado desde el marketplace.
            </p>
          </CardContent>
        </Card>
      )}
      {!loadError && !loaded && (
        <Card>
          <CardContent className="p-6 text-sm text-text-muted">Cargando módulo…</CardContent>
        </Card>
      )}
      {loaded && (
        <loaded.Component
          moduleName={loaded.metadata.moduleName}
          surface={loaded.metadata.surface}
          config={{}}
        />
      )}
    </section>
  );
}
