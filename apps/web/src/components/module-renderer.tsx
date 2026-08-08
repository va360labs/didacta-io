'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Module Renderer — Componente que carga y renderiza UI de módulos dinámicos.
 *
 * Envuelve la carga del bundle con Suspense y Error Boundary para manejar
 * estados de carga y errores de forma elegante.
 *
 * @see DISC-001.2 — Module UI Loader
 * @see module-loader.ts — Loader que hace fetch y eval del bundle
 */

import { useTranslations } from 'next-intl';
import { Component, Suspense, use, type ReactNode } from 'react';
import {
  loadModuleUI,
  ModuleUILoadError,
  ModuleUINotFoundError,
  type LoadedModuleUI,
  type ModuleUIMetadata,
} from '@/lib/module-loader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface ModuleRendererProps {
  /** Nombre del módulo (ej: "mod.migrator-learndash"). */
  moduleName: string;
  /** Surface a cargar (ej: "admin"). */
  surface: ModuleUIMetadata['surface'];
  /** Configuración actual del módulo (valores guardados en BD). */
  config: Record<string, unknown>;
  /** Fallback personalizado mientras carga. */
  loadingFallback?: ReactNode;
  /** Callback cuando la carga falla. */
  onError?: (error: Error) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renderiza la UI de un módulo dinámico.
 *
 * @example
 * ```tsx
 * <ModuleRenderer
 *   moduleName="mod.migrator-learndash"
 *   surface="admin"
 *   config={{ apiKey: '***', batchSize: 50 }}
 * />
 * ```
 */
export function ModuleRenderer({
  moduleName,
  surface,
  config,
  loadingFallback,
  onError,
}: ModuleRendererProps) {
  return (
    <ModuleErrorBoundary moduleName={moduleName} surface={surface} onError={onError}>
      <Suspense fallback={loadingFallback ?? <ModuleLoadingSkeleton />}>
        <ModuleContent moduleName={moduleName} surface={surface} config={config} />
      </Suspense>
    </ModuleErrorBoundary>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente interno que hace la carga con `use()`
// ─────────────────────────────────────────────────────────────────────────────

/** Cache de promesas para React `use()`. */
const modulePromiseCache = new Map<string, Promise<LoadedModuleUI>>();

function getModulePromise(moduleName: string, surface: ModuleUIMetadata['surface']) {
  const key = `${moduleName}:${surface}`;
  if (!modulePromiseCache.has(key)) {
    modulePromiseCache.set(key, loadModuleUI(moduleName, surface));
  }
  return modulePromiseCache.get(key)!;
}

function ModuleContent({
  moduleName,
  surface,
  config,
}: {
  moduleName: string;
  surface: ModuleUIMetadata['surface'];
  config: Record<string, unknown>;
}) {
  const loaded = use(getModulePromise(moduleName, surface));
  const { Component } = loaded;

  return <Component moduleName={moduleName} surface={surface} config={config} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Boundary
// ─────────────────────────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
  moduleName: string;
  surface: string;
  onError?: (error: Error) => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ModuleErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  handleRetry = () => {
    const key = `${this.props.moduleName}:${this.props.surface}`;
    modulePromiseCache.delete(key);
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    const { moduleName, surface, children } = this.props;

    if (error) {
      if (error instanceof ModuleUINotFoundError) {
        return <ModuleNotFoundCard moduleName={moduleName} surface={surface} />;
      }
      return (
        <ModuleErrorCard
          moduleName={moduleName}
          surface={surface}
          error={error}
          onRetry={this.handleRetry}
        />
      );
    }

    return children;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI de estados
// ─────────────────────────────────────────────────────────────────────────────

function ModuleLoadingSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72 mt-2" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      </CardContent>
    </Card>
  );
}

function ModuleNotFoundCard({ moduleName, surface }: { moduleName: string; surface: string }) {
  // `moduleName` y `surface` son identificadores del runtime de módulos
  // (protocolo, no copy): viajan como argumentos, nunca se traducen.
  const t = useTranslations('playersContenido');
  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardHeader>
        <CardTitle className="text-amber-900">{t('moduleRenderer.notFoundTitle')}</CardTitle>
        <CardDescription className="text-amber-700">
          {t.rich('moduleRenderer.notFoundDescription', {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
            moduleName,
            surface,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-amber-700">{t('moduleRenderer.notFoundHint')}</p>
      </CardContent>
    </Card>
  );
}

function ModuleErrorCard({
  moduleName,
  surface,
  error,
  onRetry,
}: {
  moduleName: string;
  surface: string;
  error: Error;
  onRetry: () => void;
}) {
  const t = useTranslations('playersContenido');
  const isLoadError = error instanceof ModuleUILoadError;

  return (
    <Card className="border-red-200 bg-red-50">
      <CardHeader>
        <CardTitle className="text-red-900">{t('moduleRenderer.errorTitle')}</CardTitle>
        <CardDescription className="text-red-700">
          {t.rich('moduleRenderer.errorDescription', {
            code: (chunks) => <code className="font-mono">{chunks}</code>,
            moduleName,
            surface,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded bg-red-100 p-3">
          <p className="text-sm font-mono text-red-800 break-all">{error.message}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('moduleRenderer.retry')}
          </Button>
          {isLoadError && (
            <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
              {t('moduleRenderer.reload')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
