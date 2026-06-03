'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authStorage } from '@/lib/auth-storage';
import { buildThemeStyleBlock, themeCache, themingApi, type TenantTheme } from '@/lib/theming';

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
