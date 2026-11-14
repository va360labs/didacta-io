'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import * as React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { authStorage } from '@/lib/auth-storage';
import { loadModuleUI, ModuleUINotFoundError, type LoadedModuleUI } from '@/lib/module-loader';

/**
 * Página host para el surface admin del módulo migrator-learndash.
 *
 * Ruta: `/admin/integrations/migrator-learndash`. Vive dentro del route
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
 *
 * Textos: los de ESTA página (marco, cargando, error de carga) en el catálogo
 * `modMigratorLearndash` del host; los del wizard viajan en el bundle del
 * módulo (`modules/migrator-learndash/src/ui/i18n.ts`), que toma el idioma del
 * runtime (`hooks.useLocale`).
 */
export default function MigratorLearndashPage(): React.ReactElement | null {
  const t = useTranslations('modMigratorLearndash');
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
        const code =
          err instanceof ModuleUINotFoundError ? 'MODULE_UI_NOT_FOUND' : 'MODULE_UI_LOAD_ERROR';
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
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('page.title')}</h1>
        </header>
        <Card>
          <CardContent className="p-6 space-y-3">
            <p className="text-sm">
              {t.rich('page.forbidden', { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
            <p className="text-sm text-text-muted">{t('page.forbiddenHint')}</p>
            <div>
              <Button asChild variant="secondary">
                <Link href="/admin">{t('page.backToAdmin')}</Link>
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
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('page.title')}</h1>
        <p className="mt-1 text-text-muted">{t('page.subtitle')}</p>
      </header>
      {loadError && (
        <Card>
          <CardContent className="p-6 space-y-3">
            <p className="text-sm text-destructive">{t('page.loadError', { error: loadError })}</p>
            <p className="text-xs text-text-muted">
              {t.rich('page.loadErrorHint', { code: (chunks) => <code>{chunks}</code> })}
            </p>
          </CardContent>
        </Card>
      )}
      {!loadError && !loaded && (
        <Card>
          <CardContent className="p-6 text-sm text-text-muted">{t('page.loading')}</CardContent>
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
