/**
 * Tests del schema de validación del form SMTP + del payload que mandamos al
 * backend.
 *
 * No usamos React Testing Library porque el repo no lo tiene instalado
 * (todos los tests de `apps/web/src` son de lógica pura: ver
 * `lib/sidebar-modules-filter.test.ts`, `modules/billing/client.test.ts`,
 * etc.). El comportamiento visual del componente queda cubierto por el
 * E2E spec `apps/e2e/tests/admin-smtp-settings.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import { smtpFormSchema } from './smtp-form-schema';

describe('smtpFormSchema', () => {
  const valid = {
    host: 'smtp.example.com',
    port: 587,
    secure: true,
    username: 'apikey',
    password: 'secret-xyz',
    fromEmail: 'noreply@example.com',
    fromName: 'Didacta',
  };

  it('parsea un form válido', () => {
    const result = smtpFormSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rechaza port fuera de rango (0)', () => {
    const result = smtpFormSchema.safeParse({ ...valid, port: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['port']);
    }
  });

  it('rechaza port fuera de rango (65536)', () => {
    const result = smtpFormSchema.safeParse({ ...valid, port: 65536 });
    expect(result.success).toBe(false);
  });

  it('rechaza fromEmail no-email', () => {
    const result = smtpFormSchema.safeParse({ ...valid, fromEmail: 'no-arroba' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['fromEmail']);
    }
  });

  it('rechaza host vacío', () => {
    const result = smtpFormSchema.safeParse({ ...valid, host: '' });
    expect(result.success).toBe(false);
  });

  it('permite password vacío (validación de "required cuando no hay guardado" la hace el caller)', () => {
    const result = smtpFormSchema.safeParse({ ...valid, password: '' });
    expect(result.success).toBe(true);
  });

  it('permite omitir fromName (opcional)', () => {
    const { fromName: _ignored, ...rest } = valid;
    void _ignored;
    const result = smtpFormSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it('coerce: port como string numérico se convierte a number', () => {
    const result = smtpFormSchema.safeParse({ ...valid, port: '465' as unknown as number });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.port).toBe(465);
    }
  });

  it('trim aplica a host y username', () => {
    const result = smtpFormSchema.safeParse({
      ...valid,
      host: '  smtp.example.com  ',
      username: '  apikey  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('smtp.example.com');
      expect(result.data.username).toBe('apikey');
    }
  });
});
