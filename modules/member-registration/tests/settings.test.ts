/**
 * Tests de `MemberRegistrationSettings` (F2 — registro componible).
 *
 * Cubre las tres resoluciones y su cascada tenant_setting → env legacy → none:
 *  - resolveTelegram: setting cifrado del tenant, fallback TELEGRAM_*, null.
 *  - resolvePolicy: setting explícito (con saneo de verificadores), default
 *    legacy (telegram+otp si hay bot; cerrado si no).
 *  - resolveEffectivePolicy: fail-closed cuando se exige telegram sin bot.
 *  - resolveApproverEmail: setting → MEMBER_APPROVAL_EMAIL → null.
 *  - Errores de descifrado se tratan como "sin setting" (cae al fallback).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberRegistrationSettings } from '../src/settings.js';

const TENANT_ID = 'tenant-1';

const ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_GROUP_ID',
  'TELEGRAM_BOT_USERNAME',
  'MEMBER_APPROVAL_EMAIL',
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/**
 * Harness con el puerto de config de tenant mockeado por clave. `values` mapea
 * "<key>" → valor devuelto; una función permite simular errores de descifrado.
 */
function makeService(values: Record<string, unknown> = {}) {
  const get = vi.fn(async (_tenantId: string, _scope: string, key: string) => {
    const v = values[key];
    if (typeof v === 'function') return (v as () => unknown)();
    return v;
  });
  const service = new MemberRegistrationSettings({ get });
  return { service, get };
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('MemberRegistrationSettings', () => {
  describe('resolveTelegram', () => {
    it('devuelve la config del setting del tenant (normaliza @ del username)', async () => {
      const { service } = makeService({
        telegram: { botToken: ' tok ', groupId: ' -100123 ', botUsername: '@mi_bot' },
      });
      expect(await service.resolveTelegram(TENANT_ID)).toEqual({
        botToken: 'tok',
        groupId: '-100123',
        botUsername: 'mi_bot',
      });
    });

    it('setting incompleto (sin groupId) se ignora y cae al fallback env', async () => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'env-tok';
      process.env['TELEGRAM_GROUP_ID'] = '-100999';
      const { service } = makeService({ telegram: { botToken: 'tok' } });
      expect(await service.resolveTelegram(TENANT_ID)).toEqual({
        botToken: 'env-tok',
        groupId: '-100999',
        botUsername: null,
      });
    });

    it('sin setting ni env devuelve null', async () => {
      const { service } = makeService();
      expect(await service.resolveTelegram(TENANT_ID)).toBeNull();
    });

    it('error de descifrado se trata como sin setting (cae al env)', async () => {
      process.env['TELEGRAM_BOT_TOKEN'] = 'env-tok';
      process.env['TELEGRAM_GROUP_ID'] = '-100999';
      const { service } = makeService({
        telegram: () => {
          throw new Error('Unsupported state or unable to authenticate data');
        },
      });
      const resolved = await service.resolveTelegram(TENANT_ID);
      expect(resolved?.botToken).toBe('env-tok');
    });
  });

  describe('resolvePolicy', () => {
    it('setting explícito manda: registro libre (enabled sin verificadores)', async () => {
      const { service } = makeService({ verification: { enabled: true, verifiers: [] } });
      expect(await service.resolvePolicy(TENANT_ID)).toEqual({ enabled: true, verifiers: [] });
    });

    it('sanea verificadores desconocidos/duplicados y normaliza el orden', async () => {
      const { service } = makeService({
        verification: { enabled: true, verifiers: ['otp', 'sms', 'telegram', 'otp'] },
      });
      expect(await service.resolvePolicy(TENANT_ID)).toEqual({
        enabled: true,
        verifiers: ['telegram', 'otp'],
      });
    });

    it('default legacy con bot configurado: habilitado con telegram+otp', async () => {
      const { service } = makeService({
        telegram: { botToken: 'tok', groupId: '-1', botUsername: null },
      });
      expect(await service.resolvePolicy(TENANT_ID)).toEqual({
        enabled: true,
        verifiers: ['telegram', 'otp'],
      });
    });

    it('default legacy sin bot: registro cerrado', async () => {
      const { service } = makeService();
      expect(await service.resolvePolicy(TENANT_ID)).toEqual({ enabled: false, verifiers: [] });
    });
  });

  describe('resolveEffectivePolicy', () => {
    it('fail-closed: exigir telegram sin bot deja el flujo NO operativo', async () => {
      const { service } = makeService({
        verification: { enabled: true, verifiers: ['telegram', 'otp'] },
      });
      const policy = await service.resolveEffectivePolicy(TENANT_ID);
      expect(policy.operational).toBe(false);
      expect(policy.botUsername).toBeNull();
    });

    it('telegram exigido y configurado: operativo y expone el botUsername', async () => {
      const { service } = makeService({
        verification: { enabled: true, verifiers: ['telegram'] },
        telegram: { botToken: 'tok', groupId: '-1', botUsername: 'mi_bot' },
      });
      const policy = await service.resolveEffectivePolicy(TENANT_ID);
      expect(policy.operational).toBe(true);
      expect(policy.botUsername).toBe('mi_bot');
    });

    it('sin telegram exigido no resuelve el bot y operational sigue a enabled', async () => {
      const { service, get } = makeService({ verification: { enabled: true, verifiers: ['otp'] } });
      const policy = await service.resolveEffectivePolicy(TENANT_ID);
      expect(policy).toMatchObject({ enabled: true, operational: true, botUsername: null });
      // Solo se leyó la política, nunca el setting del bot.
      expect(get.mock.calls.every(([, , key]) => key !== 'telegram')).toBe(true);
    });

    it('registro cerrado nunca es operativo', async () => {
      const { service } = makeService({ verification: { enabled: false, verifiers: [] } });
      const policy = await service.resolveEffectivePolicy(TENANT_ID);
      expect(policy.enabled).toBe(false);
      expect(policy.operational).toBe(false);
    });
  });

  describe('resolveApproverEmail', () => {
    it('prioriza el setting del tenant sobre la env', async () => {
      process.env['MEMBER_APPROVAL_EMAIL'] = 'global@example.com';
      const { service } = makeService({ approval: { email: ' tenant@example.com ' } });
      expect(await service.resolveApproverEmail(TENANT_ID)).toBe('tenant@example.com');
    });

    it('sin setting cae a MEMBER_APPROVAL_EMAIL', async () => {
      process.env['MEMBER_APPROVAL_EMAIL'] = 'global@example.com';
      const { service } = makeService();
      expect(await service.resolveApproverEmail(TENANT_ID)).toBe('global@example.com');
    });

    it('sin setting ni env devuelve null', async () => {
      const { service } = makeService();
      expect(await service.resolveApproverEmail(TENANT_ID)).toBeNull();
    });
  });
});
