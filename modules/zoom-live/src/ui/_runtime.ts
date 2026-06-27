/**
 * Shim que expone el runtime del host (`window.__didacta__`) al bundle UI
 * del módulo zoom-live. SIN imports directos a `react` / `@/components/ui/*`.
 *
 * Los componentes del módulo importan SOLO desde aquí. Esbuild bundlea este
 * archivo en `dist/ui/admin.js` con `--format=iife --jsx-factory=React.createElement`
 * y el resultado lee del global `window.__didacta__` que el host inicializa
 * via `initModuleRuntime()` (apps/web/src/lib/module-runtime.ts).
 *
 * NO importes nada de `react`, `@/components/ui/*` o `@/lib/*` directamente
 * desde otros archivos del módulo. Si lo haces, esbuild lo bundlea y el
 * resultado es un bundle de 500+ KB con dos copias de React.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type * as ReactTypes from 'react';
import type * as ReactDOMTypes from 'react-dom';

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
    // Constructor real del host (extends Error) para que `instanceof` estreche
    // `e` en los catch y exponga `.message`/`.status` con tipos (no `any`).
    ApiHttpError: new (payload: { message: string; status: number; code?: string }) => Error & {
      status: number;
      code?: string;
    };
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
      '[mod.zoom-live] window.__didacta__ no está inicializado. ' +
        'El bundle UI del módulo se ejecutó antes que initModuleRuntime() del host.',
    );
  }
  return rt;
}

const runtime = getRuntime();
export const React = runtime.React;
export const useState = runtime.React.useState;
export const useEffect = runtime.React.useEffect;
export const useRef = runtime.React.useRef;
export const useCallback = runtime.React.useCallback;
export const Fragment = runtime.React.Fragment;

export const Button = runtime.ui.Button;
export const Card = runtime.ui.Card;
export const CardContent = runtime.ui.CardContent;
export const CardDescription = runtime.ui.CardDescription;
export const CardHeader = runtime.ui.CardHeader;
export const CardTitle = runtime.ui.CardTitle;
export const Input = runtime.ui.Input;
export const Label = runtime.ui.Label;

export const apiFetchAuth = runtime.api.fetchAuth;
export const ApiHttpError = runtime.api.ApiHttpError;
