/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Hook useLicense() y componente <EeGate> para frontend Next/React.
 *
 * El frontend NO verifica licencias por sí mismo (eso lo hace el backend).
 * Solo consulta un endpoint del API que devuelve el estado serializado para
 * pintar la UI correctamente.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  LICENSE_CAPABILITIES,
  type LicenseCapability,
} from './capabilities.js';
import type { LicenseStatus } from './types.js';

/**
 * Estado serializable que el backend manda al frontend (sin secretos).
 */
export interface PublicLicenseState {
  status: LicenseStatus;
  edition?: 'community' | 'enterprise' | 'cloud';
  organizationName?: string;
  expiresAt?: string;
  capabilities: string[];
  warnings: string[];
}

const DEFAULT_STATE: PublicLicenseState = {
  status: 'community',
  capabilities: [],
  warnings: [],
};

interface LicenseContextValue {
  state: PublicLicenseState;
  loading: boolean;
  refresh: () => Promise<void>;
  isCapabilityEnabled: (capability: LicenseCapability | string) => boolean;
}

const LicenseContext = createContext<LicenseContextValue>({
  state: DEFAULT_STATE,
  loading: false,
  refresh: async () => {},
  isCapabilityEnabled: () => false,
});

export interface LicenseProviderProps {
  /** Endpoint del API que devuelve PublicLicenseState. Default '/api/license'. */
  endpoint?: string;
  /** Opcional: estado inicial (SSR / hidratación). */
  initialState?: PublicLicenseState;
  children: ReactNode;
}

export function LicenseProvider({
  endpoint = '/api/license',
  initialState,
  children,
}: LicenseProviderProps) {
  const [state, setState] = useState<PublicLicenseState>(initialState ?? DEFAULT_STATE);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(endpoint, { credentials: 'include' });
      if (res.ok) {
        const body = (await res.json()) as PublicLicenseState;
        setState(body);
      }
    } catch {
      // Silently keep previous state. Frontend NEVER decides license; backend authoritative.
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    if (!initialState) {
      void refresh();
    }
  }, [initialState, refresh]);

  const value = useMemo<LicenseContextValue>(
    () => ({
      state,
      loading,
      refresh,
      isCapabilityEnabled: (capability) => {
        if (state.status === 'dev') return true;
        if (
          state.status === 'community' ||
          state.status === 'invalid' ||
          state.status === 'expired'
        ) {
          return false;
        }
        return state.capabilities.includes(capability);
      },
    }),
    [state, loading, refresh],
  );

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}

export function useLicense(): LicenseContextValue {
  return useContext(LicenseContext);
}

export type EeGateMode = 'hidden' | 'locked' | 'limited';

export interface EeGateProps {
  capability: LicenseCapability | string;
  mode?: EeGateMode;
  /** Contenido a mostrar cuando la capability está activa. */
  children: ReactNode;
  /** UI alternativa cuando bloqueada. Si se omite, usa default según mode. */
  fallback?: ReactNode;
}

/**
 * Componente declarativo. Tres modos:
 *
 *  - 'hidden': si no está activa, renderiza null.
 *  - 'locked': si no está activa, muestra UI de upgrade (default) o `fallback`.
 *  - 'limited': si no está activa, muestra `fallback` (no hay default).
 *
 * IMPORTANTE: el frontend NO es la fuente de verdad. Cualquier endpoint del API
 * sigue protegido por LicenseGuard en backend. EeGate es solo UX.
 */
export function EeGate({
  capability,
  mode = 'locked',
  children,
  fallback,
}: EeGateProps) {
  const { isCapabilityEnabled, state } = useLicense();

  if (isCapabilityEnabled(capability)) {
    return <>{children}</>;
  }

  if (mode === 'hidden') return null;

  if (fallback !== undefined) return <>{fallback}</>;

  if (mode === 'locked') {
    return <DefaultLockedView capability={capability} status={state.status} />;
  }

  return null;
}

function DefaultLockedView({
  capability,
  status,
}: {
  capability: LicenseCapability | string;
  status: LicenseStatus;
}) {
  const reason =
    status === 'expired'
      ? 'Your Enterprise license has expired.'
      : status === 'invalid'
        ? 'Your Enterprise license is invalid.'
        : 'This feature requires Didacta Enterprise.';

  return (
    <div
      role="region"
      aria-label="Enterprise feature gate"
      style={{
        padding: '1.5rem',
        border: '1px solid #d1d5db',
        borderRadius: '0.5rem',
        background: '#f9fafb',
        textAlign: 'center' as const,
      }}
    >
      <strong style={{ display: 'block', marginBottom: '0.5rem' }}>🔒 {reason}</strong>
      <p style={{ marginBottom: '1rem', color: '#4b5563' }}>
        Capability required: <code>{capability}</code>
      </p>
      <a
        href="https://didacta.io/pricing"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-block',
          padding: '0.5rem 1rem',
          background: '#111827',
          color: '#fff',
          borderRadius: '0.375rem',
          textDecoration: 'none',
        }}
      >
        Upgrade to Enterprise
      </a>
    </div>
  );
}

export { LICENSE_CAPABILITIES };
