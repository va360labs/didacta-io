/**
 * Shim que expone el runtime del host (`window.__didacta__`) al bundle UI
 * del módulo. SIN imports directos a `react` / `@/components/ui/*` / `@/lib/*`.
 *
 * Los componentes del módulo importan SOLO desde aquí. Esbuild bundlea este
 * archivo en `dist/ui/admin.js` con `--format=iife --jsx-factory=React.createElement`
 * y el resultado lee del global `window.__didacta__` que el host inicializa
 * via `initModuleRuntime()` (apps/web/src/lib/module-runtime.ts).
 *
 * Beneficio de este patrón:
 *   - El bundle del módulo es delgado (~30 KB en lugar de ~500 KB).
 *   - React y shadcn/ui son singleton: NO se duplican entre host y módulo
 *     → cero "Invalid hook call" por dos copias de React.
 *   - El módulo respeta ADR-015 (independencia total respecto al host).
 *
 * Si necesitás un componente que NO está en `__didacta__`:
 *   1. Agregalo a `apps/web/src/lib/module-runtime.ts`.
 *   2. Bumpá `runtime.version` en ese archivo.
 *   3. Re-bumpá `coreVersionRequired` en el manifest del módulo si querés
 *      forzar que solo hosts con el componente puedan instalar este módulo.
 *
 * NO importes nada de `react`, `@/components/ui/*`, `@/lib/auth-storage` ni
 * `@/lib/api-client` directamente desde otros archivos del módulo. Si lo
 * hacés, esbuild lo intentará bundlear y el resultado va a ser un bundle de
 * 500+ KB con dos copias de React.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// `import type` queda 100% borrado por esbuild — no se bundlea `react` ni
// `react-dom`. Solo se usa para que TypeScript pueda tipar `React.ReactNode`,
// JSX intrinsics, hooks (useState, useEffect, useRef), etc. Sin esto, el
// código del módulo ve `React` como `any` y JSX no typechequea.
import type * as ReactTypes from 'react';
import type * as ReactDOMTypes from 'react-dom';

// Tipo aproximado del runtime. Sincronizado a mano con DidactaRuntime del
// host (apps/web/src/lib/module-runtime.ts). Si el host añade entries
// nuevos al runtime, los reflejamos aquí para autocompletado.
interface DidactaRuntime {
  version: string;
  React: typeof ReactTypes;
  ReactDOM: typeof ReactDOMTypes;
  ui: {
    Badge: any;
    Button: any;
    buttonVariants: any;
    Card: any;
    CardContent: any;
    CardDescription: any;
    CardHeader: any;
    CardTitle: any;
    Dialog: any;
    DialogContent: any;
    DialogDescription: any;
    DialogHeader: any;
    DialogTitle: any;
    DialogTrigger: any;
    Input: any;
    Label: any;
    Progress: any;
    Select: any;
    SelectContent: any;
    SelectItem: any;
    SelectTrigger: any;
    SelectValue: any;
    Skeleton: any;
    Switch: any;
    Tabs: any;
    TabsContent: any;
    TabsList: any;
    TabsTrigger: any;
    Textarea: any;
    AlertDialog: any;
    AlertDialogAction: any;
    AlertDialogCancel: any;
    AlertDialogContent: any;
    AlertDialogDescription: any;
    AlertDialogFooter: any;
    AlertDialogHeader: any;
    AlertDialogTitle: any;
  };
  hooks: { useTenantContext: any };
  api: {
    fetch: <T>(path: string, init?: RequestInit, bearer?: string) => Promise<T>;
    fetchAuth: <T>(path: string, init?: RequestInit) => Promise<T>;
    ApiHttpError: any;
    me: any;
    marketplace: any;
  };
  utils: { cn: any; z: any };
}

function getRuntime(): DidactaRuntime {
  const w = (typeof window !== 'undefined' ? window : undefined) as
    | (Window & { __didacta__?: DidactaRuntime })
    | undefined;
  const rt = w?.__didacta__;
  if (!rt) {
    throw new Error(
      '[mod.migrator-learndash] window.__didacta__ no está inicializado. ' +
        'El bundle UI del módulo se ejecutó antes que initModuleRuntime() del host. ' +
        'Esto es un bug del host — el module-loader del host debe llamar initModuleRuntime() ' +
        'antes de evaluar este bundle.',
    );
  }
  return rt;
}

// React core + hooks habituales. `React` se exporta para que JSX classic
// transform encuentre `React.createElement` en scope cuando esbuild
// procesa los .tsx con `--jsx-factory=React.createElement`.
const runtime = getRuntime();
export const React = runtime.React;
export const useState = runtime.React.useState;
export const useEffect = runtime.React.useEffect;
export const useRef = runtime.React.useRef;
export const useCallback = runtime.React.useCallback;
export const useMemo = runtime.React.useMemo;
export const Fragment = runtime.React.Fragment;

// UI components (shadcn/ui).
export const Badge = runtime.ui.Badge;
export const Button = runtime.ui.Button;
export const Card = runtime.ui.Card;
export const CardContent = runtime.ui.CardContent;
export const CardDescription = runtime.ui.CardDescription;
export const CardHeader = runtime.ui.CardHeader;
export const CardTitle = runtime.ui.CardTitle;
export const Input = runtime.ui.Input;
export const Label = runtime.ui.Label;
export const Switch = runtime.ui.Switch;
export const Tabs = runtime.ui.Tabs;
export const TabsContent = runtime.ui.TabsContent;
export const TabsList = runtime.ui.TabsList;
export const TabsTrigger = runtime.ui.TabsTrigger;
export const Textarea = runtime.ui.Textarea;
export const AlertDialog = runtime.ui.AlertDialog;
export const AlertDialogAction = runtime.ui.AlertDialogAction;
export const AlertDialogCancel = runtime.ui.AlertDialogCancel;
export const AlertDialogContent = runtime.ui.AlertDialogContent;
export const AlertDialogDescription = runtime.ui.AlertDialogDescription;
export const AlertDialogFooter = runtime.ui.AlertDialogFooter;
export const AlertDialogHeader = runtime.ui.AlertDialogHeader;
export const AlertDialogTitle = runtime.ui.AlertDialogTitle;

// API helpers.
export const apiFetch = runtime.api.fetch;
export const apiFetchAuth = runtime.api.fetchAuth;
export const ApiHttpError = runtime.api.ApiHttpError;
