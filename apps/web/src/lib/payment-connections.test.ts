import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';
import es from '@/i18n/messages/es';
import en from '@/i18n/messages/en';
import {
  classifySubscriptionStatus,
  connectionStatusStyle,
  subscriptionStatusLabel,
} from './payment-connections';

/**
 * Guardia de PARIDAD de `classifySubscriptionStatus`.
 *
 * Esta función está duplicada a propósito: la copia canónica vive en el módulo
 * backend `modules/payment-connections/src/payment-connections.service.ts` y esta
 * es su espejo en la web (apps/web no puede importar `@didacta/mod-payment-connections`,
 * mismo patrón que `formatAmount`). Para que las dos copias NO diverjan en silencio,
 * la tabla de abajo es IDÉNTICA a `SUBSCRIPTION_STATUS_TABLE` del test del módulo
 * (`modules/payment-connections/tests/payment-connections.service.test.ts`): si una
 * copia se edita sin la otra, su test falla.
 */
const SUBSCRIPTION_STATUS_TABLE: Record<
  string,
  { category: string; label: string; entitled: boolean }
> = {
  active: { category: 'active', label: 'Activa', entitled: true },
  trialing: { category: 'active', label: 'En prueba', entitled: true },
  past_due: { category: 'past_due', label: 'Pago atrasado (impago)', entitled: true },
  unpaid: { category: 'unpaid', label: 'Impago — suspendida', entitled: false },
  'on-hold': { category: 'past_due', label: 'En espera (impago)', entitled: true },
  paused: { category: 'paused', label: 'Pausada', entitled: false },
  'pending-cancel': { category: 'canceled', label: 'Baja programada', entitled: true },
  canceled: { category: 'canceled', label: 'Dada de baja', entitled: false },
  cancelled: { category: 'canceled', label: 'Dada de baja', entitled: false },
  expired: { category: 'canceled', label: 'Expirada', entitled: false },
  incomplete: { category: 'incomplete', label: 'Pago no completado', entitled: false },
  incomplete_expired: { category: 'incomplete', label: 'Pago no completado', entitled: false },
  pending: { category: 'incomplete', label: 'Pendiente de pago', entitled: false },
};

describe('classifySubscriptionStatus (web · paridad con el módulo)', () => {
  it('respeta la misma tabla canónica de (category, label, entitled)', () => {
    for (const [status, expected] of Object.entries(SUBSCRIPTION_STATUS_TABLE)) {
      expect({ status, ...classifySubscriptionStatus(status) }).toEqual({ status, ...expected });
    }
  });

  it('normaliza mayúsculas/espacios y cae a "Desconocido" en estados no reconocidos', () => {
    expect(classifySubscriptionStatus('  ACTIVE ').entitled).toBe(true);
    const unknown = classifySubscriptionStatus('rarísimo');
    expect(unknown).toEqual({ category: 'unknown', label: 'rarísimo', entitled: false });
  });
});

/**
 * Etiqueta de PANTALLA del estado de una suscripción.
 *
 * El bug que cierra: `/admin/solicitudes-miembros` pintaba el estado con
 * `classifySubscriptionStatus(...).label`, que redacta en español fijo porque
 * es el espejo del enum del backend, no copy. Un admin con la UI en inglés leía
 * «Activa» / «Dada de baja» en mitad de la frase.
 */
describe('subscriptionStatusLabel', () => {
  const tEs = createTranslator({ locale: 'es-ES', messages: es, namespace: 'adminPagos' });
  const tEn = createTranslator({ locale: 'en-US', messages: en, namespace: 'adminPagos' });

  it('en español sale BYTE A BYTE lo que ya daba classifySubscriptionStatus', () => {
    for (const status of Object.keys(SUBSCRIPTION_STATUS_TABLE)) {
      expect(subscriptionStatusLabel(status, tEs), status).toBe(
        classifySubscriptionStatus(status).label,
      );
    }
  });

  it('en inglés sale del catálogo inglés, no del español', () => {
    expect(subscriptionStatusLabel('active', tEn)).toBe('Active');
    expect(subscriptionStatusLabel('canceled', tEn)).toBe('Canceled');
    expect(subscriptionStatusLabel('cancelled', tEn)).toBe('Canceled');
    expect(subscriptionStatusLabel('past_due', tEn)).toBe('Past due (overdue)');
    // Los 13 estados conocidos tienen etiqueta propia en ambos idiomas y NINGUNA
    // se queda en español dentro de la UI inglesa.
    for (const status of Object.keys(SUBSCRIPTION_STATUS_TABLE)) {
      expect(subscriptionStatusLabel(status, tEn), status).not.toBe(
        subscriptionStatusLabel(status, tEs),
      );
    }
  });

  it('normaliza mayúsculas y espacios igual que la clasificación', () => {
    expect(subscriptionStatusLabel('  ACTIVE ', tEs)).toBe('Activa');
    expect(subscriptionStatusLabel('  ACTIVE ', tEn)).toBe('Active');
  });

  it('CAMINO DEGRADADO: estado desconocido → valor crudo del proveedor, nunca la key', () => {
    for (const t of [tEs, tEn]) {
      const salida = subscriptionStatusLabel('paused_indefinitely', t);
      expect(salida).toBe('paused_indefinitely');
      expect(salida).not.toContain('subStatus');
    }
  });

  it('CAMINO DEGRADADO: solo un estado VACÍO cae a la etiqueta de desconocido', () => {
    expect(subscriptionStatusLabel('', tEs)).toBe('Desconocido');
    expect(subscriptionStatusLabel('', tEn)).toBe('Unknown');
  });
});

/**
 * Camino degradado de la badge de estado de una conexión.
 *
 * El bug que cierra: la página indexaba el mapa de estilos a pelo
 * (`map[status].key`). Un estado que el front no conozca —basta un deploy de
 * API por delante del de web— daba `undefined`, leer `.key` lanzaba un
 * TypeError y el error boundary dejaba TODA la pantalla de conexiones de pago
 * en blanco por una sola fila.
 */
describe('connectionStatusStyle', () => {
  it('los 4 estados conocidos traen su key de catálogo', () => {
    expect(connectionStatusStyle('VERIFIED').key).toBe('verified');
    expect(connectionStatusStyle('ERROR').key).toBe('error');
    expect(connectionStatusStyle('PENDING').key).toBe('pending');
    expect(connectionStatusStyle('DISCONNECTED').key).toBe('disconnected');
  });

  it('CAMINO DEGRADADO: un estado desconocido devuelve estilo neutro, no revienta', () => {
    for (const status of ['REVOKED', '', 'verified', 'ESTADO_NUEVO_DE_LA_API']) {
      const cfg = connectionStatusStyle(status);
      expect(cfg, status).toEqual({ key: null, variant: 'outline' });
      // `key: null` es lo que le dice al caller que pinte el código crudo en
      // vez de construir `connStatus.undefined` y pintar la key en pantalla.
      expect(cfg.key, status).toBeNull();
    }
  });
});
