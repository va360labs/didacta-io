/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Module Runtime — Expone dependencias del host a módulos dinámicos.
 *
 * Los módulos instalados vía marketplace traen su UI como bundles JS
 * pre-compilados (esbuild, formato IIFE). Estos bundles NO incluyen React,
 * shadcn/ui ni otras dependencias del host — las consumen vía el objeto
 * global `__didacta__` que este archivo inicializa.
 *
 * ARQUITECTURA:
 *   1. El host llama `initModuleRuntime()` una vez al cargar la app.
 *   2. El bundle del módulo accede a `window.__didacta__` para React, UI, etc.
 *   3. El módulo exporta su componente vía `window.ModuleUI = { default: ... }`.
 *   4. El host captura ese export y lo renderiza con Suspense.
 *
 * Esta alternativa a Module Federation es más compatible con Next.js 15 App
 * Router y no depende de plugins de webpack en mantenimiento incierto.
 *
 * @see DISC-001 — Sistema de Plugins (decision log interno).
 */

import React from 'react';
import ReactDOM from 'react-dom';
import { useLocale } from 'next-intl';
import { z } from 'zod';

// UI Components (shadcn/ui)
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Utilities
import { cn } from '@/lib/utils';

// APIs
import { apiFetch, ApiHttpError } from '@/lib/api-client';
import { meApi } from '@/lib/me';
import { marketplaceApi } from '@/lib/marketplace';
import { authStorage } from '@/lib/auth-storage';

// Hooks/Context
import { useTenantContext } from '@/lib/tenant-context';

// Idioma
import { DEFAULT_LOCALE } from '@/i18n/config';
import { getUserFormatPrefs } from '@/lib/i18n/user-prefs';

/**
 * Versión del runtime. Se sube al añadir algo al contrato para que un módulo
 * pueda comprobar si el host lo tiene.
 *
 *   1.0.0 — React, shadcn/ui, api, utils, `hooks.useTenantContext`.
 *   1.1.0 — idioma activo: `hooks.useLocale` e `i18n.getLocale()`.
 */
export const MODULE_RUNTIME_VERSION = '1.1.0';

/**
 * Idioma con el que se está pintando la interfaz, para quien lo necesite FUERA
 * de un render (un `catch`, un formateador). `<html lang>` lo fija el layout
 * raíz con el locale de next-intl y se actualiza con el `router.refresh()` de
 * `LocaleSync` al cambiar de idioma; el singleton de `user-prefs` (que también
 * escribe `LocaleSync`) y `DEFAULT_LOCALE` solo cubren un documento sin `lang`.
 */
function getActiveLocale(): string {
  const fromHtml = typeof document !== 'undefined' ? document.documentElement.lang : '';
  return fromHtml || getUserFormatPrefs().locale || DEFAULT_LOCALE;
}

/**
 * Tipo del objeto global `__didacta__`.
 *
 * Los módulos TypeScript pueden declarar esto para obtener autocompletado:
 * ```ts
 * declare const __didacta__: import('@didacta/web/module-runtime').DidactaRuntime;
 * ```
 */
export interface DidactaRuntime {
  /** Versión del runtime (para compat checks). */
  version: string;

  /** React core — singleton compartido. */
  React: typeof React;
  ReactDOM: typeof ReactDOM;

  /** Componentes UI (shadcn/ui). */
  ui: {
    Badge: typeof Badge;
    Button: typeof Button;
    buttonVariants: typeof buttonVariants;
    Card: typeof Card;
    CardContent: typeof CardContent;
    CardDescription: typeof CardDescription;
    CardHeader: typeof CardHeader;
    CardTitle: typeof CardTitle;
    Dialog: typeof Dialog;
    DialogContent: typeof DialogContent;
    DialogDescription: typeof DialogDescription;
    DialogHeader: typeof DialogHeader;
    DialogTitle: typeof DialogTitle;
    DialogTrigger: typeof DialogTrigger;
    Input: typeof Input;
    Label: typeof Label;
    Progress: typeof Progress;
    Select: typeof Select;
    SelectContent: typeof SelectContent;
    SelectItem: typeof SelectItem;
    SelectTrigger: typeof SelectTrigger;
    SelectValue: typeof SelectValue;
    Skeleton: typeof Skeleton;
    Switch: typeof Switch;
    Tabs: typeof Tabs;
    TabsContent: typeof TabsContent;
    TabsList: typeof TabsList;
    TabsTrigger: typeof TabsTrigger;
    Textarea: typeof Textarea;
    AlertDialog: typeof AlertDialog;
    AlertDialogAction: typeof AlertDialogAction;
    AlertDialogCancel: typeof AlertDialogCancel;
    AlertDialogContent: typeof AlertDialogContent;
    AlertDialogDescription: typeof AlertDialogDescription;
    AlertDialogFooter: typeof AlertDialogFooter;
    AlertDialogHeader: typeof AlertDialogHeader;
    AlertDialogTitle: typeof AlertDialogTitle;
  };

  /** Hooks y contextos del host. */
  hooks: {
    useTenantContext: typeof useTenantContext;
    /**
     * (1.1.0) Idioma activo de la interfaz como tag BCP 47 (`es-ES`, `es-AR`,
     * `en-US`, `pt-BR`): el `useLocale` de next-intl. Al ser un hook, el
     * componente que lo usa se vuelve a pintar si el idioma cambia.
     */
    useLocale: typeof useLocale;
    // Añadir más hooks según se expongan
  };

  /** (1.1.0) Idioma. Los textos de cada módulo viven en el propio módulo. */
  i18n: {
    /**
     * Idioma activo (mismo tag que `hooks.useLocale`) leído en el momento de
     * la llamada, para usarlo fuera de un render. Dentro de un componente,
     * mejor `hooks.useLocale`.
     */
    getLocale: () => string;
  };

  /** APIs del core. */
  api: {
    fetch: typeof apiFetch;
    /**
     * Wrapper de fetch que resuelve el bearer token desde `authStorage`
     * automáticamente. Pensado para los módulos que no necesitan auth
     * granular y solo quieren llamar a sus propias rutas autenticadas
     * sin reimplementar el storage del token. Lanza `ApiHttpError(401)`
     * si no hay sesión vigente.
     */
    fetchAuth: <T>(path: string, init?: RequestInit) => Promise<T>;
    ApiHttpError: typeof ApiHttpError;
    me: typeof meApi;
    marketplace: typeof marketplaceApi;
    // Añadir más APIs según se expongan
  };

  /** Utilidades. */
  utils: {
    cn: typeof cn;
    z: typeof z;
  };
}

declare global {
  interface Window {
    __didacta__?: DidactaRuntime;
    /** Export temporal del módulo cargado dinámicamente. */
    __didacta_module_exports__?: Record<string, unknown>;
  }
}

/**
 * Inicializa el runtime global `__didacta__`.
 *
 * Debe llamarse UNA vez al montar la aplicación (en el layout root o en un
 * provider). Es idempotente: si ya existe, no lo sobrescribe.
 *
 * @returns El objeto runtime (para testing o inspección).
 */
export function initModuleRuntime(): DidactaRuntime {
  if (typeof window === 'undefined') {
    throw new Error('initModuleRuntime() solo puede ejecutarse en el browser');
  }

  if (window.__didacta__) {
    return window.__didacta__;
  }

  const runtime: DidactaRuntime = {
    version: MODULE_RUNTIME_VERSION,

    React,
    ReactDOM,

    ui: {
      Badge,
      Button,
      buttonVariants,
      Card,
      CardContent,
      CardDescription,
      CardHeader,
      CardTitle,
      Dialog,
      DialogContent,
      DialogDescription,
      DialogHeader,
      DialogTitle,
      DialogTrigger,
      Input,
      Label,
      Progress,
      Select,
      SelectContent,
      SelectItem,
      SelectTrigger,
      SelectValue,
      Skeleton,
      Switch,
      Tabs,
      TabsContent,
      TabsList,
      TabsTrigger,
      Textarea,
      AlertDialog,
      AlertDialogAction,
      AlertDialogCancel,
      AlertDialogContent,
      AlertDialogDescription,
      AlertDialogFooter,
      AlertDialogHeader,
      AlertDialogTitle,
    },

    hooks: {
      useTenantContext,
      useLocale,
    },

    i18n: {
      getLocale: getActiveLocale,
    },

    api: {
      fetch: apiFetch,
      fetchAuth: <T>(path: string, init: RequestInit = {}): Promise<T> => {
        const token = authStorage.getAccessToken();
        if (!token) {
          throw new ApiHttpError({
            message: 'Sesión expirada',
            status: 401,
            code: 'sessionExpired',
          });
        }
        return apiFetch<T>(path, init, token);
      },
      ApiHttpError,
      me: meApi,
      marketplace: marketplaceApi,
    },

    utils: {
      cn,
      z,
    },
  };

  window.__didacta__ = runtime;

  return runtime;
}

/**
 * Obtiene el runtime, lanzando error si no está inicializado.
 */
export function getModuleRuntime(): DidactaRuntime {
  if (typeof window === 'undefined') {
    throw new Error('getModuleRuntime() solo puede ejecutarse en el browser');
  }
  if (!window.__didacta__) {
    throw new Error('Module runtime no inicializado. Llama initModuleRuntime() primero.');
  }
  return window.__didacta__;
}
