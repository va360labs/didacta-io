/**
 * Tests de la `TenantIdentityCard` (alpha.78).
 *
 * No usamos React Testing Library — el repo no la tiene instalada (todos
 * los tests de `apps/web/src/*` son de lógica pura; ver el comment en
 * `smtp-settings-card.test.ts`). Acá testeamos la función pura
 * `canSaveTenantName`, que encapsula 100% de la lógica de gating del
 * botón "Guardar" extraída del componente para que sea testeable sin DOM.
 *
 * El comportamiento visual y los handlers async (carga inicial, submit,
 * reload tras success) se prueban via el cliente HTTP en
 * `apps/web/src/lib/admin-tenants.test.ts` + en el path manual del E2E
 * de configuración cuando se añada en una versión futura.
 */

import { describe, expect, it } from 'vitest';
import { canSaveTenantName, MAX_TENANT_NAME_LEN } from '@/components/admin/tenant-identity-card';

describe('canSaveTenantName', () => {
  const baseline = 'Acme Corp Training';

  it('false cuando el tenant aún no se cargó (currentName=null)', () => {
    expect(canSaveTenantName({ currentName: null, draftName: 'Lo que sea', saving: false })).toBe(
      false,
    );
  });

  it('false mientras está guardando', () => {
    expect(
      canSaveTenantName({ currentName: baseline, draftName: 'Nuevo nombre', saving: true }),
    ).toBe(false);
  });

  it('false cuando el draft trimmed iguala al nombre actual', () => {
    expect(canSaveTenantName({ currentName: baseline, draftName: baseline, saving: false })).toBe(
      false,
    );
  });

  it('false cuando el draft está vacío', () => {
    expect(canSaveTenantName({ currentName: baseline, draftName: '', saving: false })).toBe(false);
  });

  it('false cuando el draft es sólo whitespace', () => {
    expect(canSaveTenantName({ currentName: baseline, draftName: '   ', saving: false })).toBe(
      false,
    );
  });

  it(`false cuando el draft excede ${MAX_TENANT_NAME_LEN} chars`, () => {
    const tooLong = 'a'.repeat(MAX_TENANT_NAME_LEN + 1);
    expect(canSaveTenantName({ currentName: baseline, draftName: tooLong, saving: false })).toBe(
      false,
    );
  });

  it(`true cuando el draft tiene exactamente ${MAX_TENANT_NAME_LEN} chars y no coincide`, () => {
    const justRight = 'a'.repeat(MAX_TENANT_NAME_LEN);
    expect(canSaveTenantName({ currentName: baseline, draftName: justRight, saving: false })).toBe(
      true,
    );
  });

  it('true cuando el draft trimmed cambia y todo lo demás está OK', () => {
    expect(
      canSaveTenantName({ currentName: baseline, draftName: 'VA360 Academy', saving: false }),
    ).toBe(true);
  });

  it('aplica trim antes de comparar (los espacios alrededor no cuentan como cambio)', () => {
    expect(
      canSaveTenantName({ currentName: baseline, draftName: `  ${baseline}  `, saving: false }),
    ).toBe(false);
  });
});
