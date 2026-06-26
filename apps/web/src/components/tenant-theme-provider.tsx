'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authStorage } from '@/lib/auth-storage';
import {
  buildThemeStyleBlock,
  SESSION_THEME_REFRESH_EVENT,
  THEME_UPDATED_EVENT,
  themeCache,
  themingApi,
  type TenantTheme,
} from '@/lib/theming';

/**
 * Contexto del theme del tenant. Expone el theme vivo (o null mientras no hay
 * sesión / cache) para que componentes como el sidebar consuman `logoUrl` y
 * derivados sin re-fetchear. El `<style>` + favicon se inyectan en el DOM por
 * el provider; este contexto es para los datos (logo, etc.).
 */
const TenantThemeContext = createContext<TenantTheme | null>(null);

/** Hook para leer el theme del tenant desde cualquier client component. */
export function useTenantTheme(): TenantTheme | null {
  return useContext(TenantThemeContext);
}

/**
 * TenantThemeProvider — montado en el ROOT layout (apps/web/src/app/layout.tsx)
 * para que el branding cubra TANTO la app autenticada (app) como las pantallas
 * de auth ((auth)/signin, reset-password, etc.). Diseñado para producir CERO
 * FOUC:
 *
 *  1. Render inicial: si hay cache (localStorage) → CSS aplicado de inmediato.
 *  2. Sin cache: aplica defaults Didacta (los que ya están en globals.css).
 *  3. En paralelo, si hay sesión + token, refresca contra API y persiste.
 *
 * En las pantallas de auth no hay sesión, así que el theme queda en null y se
 * usan los defaults de globals.css — comportamiento correcto: el login todavía
 * no sabe a qué tenant pertenece el visitante.
 */
export function TenantThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<TenantTheme | null>(() => {
    if (typeof window === 'undefined') return null;
    const session = authStorage.getSession();
    if (!session) return null;
    return themeCache.load(session.user.tenantId);
  });

  useEffect(() => {
    let cancelled = false;
    const session = authStorage.getSession();
    const token = authStorage.getAccessToken();
    if (!session || !token) return;

    void (async () => {
      try {
        const fresh = await themingApi.getMine(token);
        if (cancelled) return;
        setTheme(fresh);
        themeCache.save(fresh);
      } catch {
        // Falla silenciosa: el tenant queda con defaults Didacta. El log
        // queda en la consola del fetch pero no rompemos la UI.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Aplicación EN VIVO: cuando /admin/branding guarda (o resetea / cambia el
  // logo) publica el theme nuevo por window. El provider lo recoge y reaplica
  // el `<style>` global sin recargar — antes el cambio solo se veía tras un
  // reload duro porque este provider solo fetchea en el mount.
  useEffect(() => {
    function onThemeUpdated(e: Event) {
      const detail = (e as CustomEvent<TenantTheme>).detail;
      if (detail) setTheme(detail);
    }
    window.addEventListener(THEME_UPDATED_EVENT, onThemeUpdated);
    return () => window.removeEventListener(THEME_UPDATED_EVENT, onThemeUpdated);
  }, []);

  // Re-fetch tras login: el provider vive en el root layout y NO se re-monta en
  // navegaciones SPA, así que el fetch de mount (hecho en /signin, sin token) no
  // vuelve a correr → el logo del tenant no aparecía hasta recargar. El signin
  // dispara SESSION_THEME_REFRESH_EVENT y aquí recogemos el branding al vuelo.
  useEffect(() => {
    function onRefresh() {
      const token = authStorage.getAccessToken();
      if (!token) {
        // Logout: sin sesión NO debe quedar pegada la marca del tenant anterior
        // sobre las pantallas de auth (este provider vive en el root layout y no
        // se re-monta). Volvemos a los defaults Didacta.
        setTheme(null);
        return;
      }
      void themingApi
        .getMine(token)
        .then((fresh) => {
          setTheme(fresh);
          themeCache.save(fresh);
        })
        .catch(() => {
          // Falla silenciosa: se mantienen los defaults Didacta.
        });
    }
    window.addEventListener(SESSION_THEME_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(SESSION_THEME_REFRESH_EVENT, onRefresh);
  }, []);

  return (
    <TenantThemeContext.Provider value={theme}>
      {theme ? (
        <style
          // dangerouslySetInnerHTML es seguro acá porque el contenido proviene
          // de buildThemeStyleBlock — los inputs ya pasaron por el sanitizer
          // de mod.theming en el backend (whitelists + regex de patrones
          // forbidden).
          dangerouslySetInnerHTML={{ __html: buildThemeStyleBlock(theme) }}
        />
      ) : null}
      {theme?.faviconUrl ? (
        // Favicon dinámico: solo se aplica si el tenant lo configuró.
        <link rel="icon" href={theme.faviconUrl} />
      ) : null}
      {children}
    </TenantThemeContext.Provider>
  );
}
