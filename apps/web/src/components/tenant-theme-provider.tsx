'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { authStorage } from '@/lib/auth-storage';
import { buildThemeStyleBlock, themeCache, themingApi, type TenantTheme } from '@/lib/theming';

/**
 * TenantThemeProvider — montado en (app)/layout.tsx para inyectar tokens
 * del theme del tenant en el head. Diseñado para producir CERO FOUC:
 *
 *  1. Render inicial: si hay cache → CSS aplicado de inmediato.
 *  2. Sin cache: aplica defaults Didacta (los que ya están en globals.css).
 *  3. En paralelo, refresca contra API y persiste si cambió.
 *
 * El componente devuelve los children sin envolverlos en wrappers extra
 * para no agregar nodos al DOM.
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
    <>
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
    </>
  );
}
