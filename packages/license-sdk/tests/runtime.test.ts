/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LicenseService } from '../src/runtime.js';
import { LICENSE_CAPABILITIES } from '../src/capabilities.js';
import { CapabilityRequiredError } from '../src/types.js';
import { issueTestLicense } from './setup-test-keys.js';

describe('LicenseService', () => {
  let svc: LicenseService;

  beforeEach(() => {
    svc = new LicenseService();
  });

  describe('community state (no license)', () => {
    it('returns community status when key is null', async () => {
      const state = await svc.load({ key: null });
      expect(state.status).toBe('community');
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.MULTI_TENANT_REAL)).toBe(false);
    });

    it('returns community status when key is undefined', async () => {
      const state = await svc.load({});
      expect(state.status).toBe('community');
    });

    it('throws CapabilityRequiredError on requireCapability', async () => {
      await svc.load({});
      expect(() => svc.requireCapability(LICENSE_CAPABILITIES.SCIM)).toThrow(
        CapabilityRequiredError,
      );
    });
  });

  describe('active state', () => {
    it('enables only the capabilities present in the payload', async () => {
      const token = await issueTestLicense({
        capabilities: [LICENSE_CAPABILITIES.MULTI_TENANT_REAL, LICENSE_CAPABILITIES.WHITE_LABEL],
      });
      const state = await svc.load({ key: token });
      expect(state.status).toBe('active');
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.MULTI_TENANT_REAL)).toBe(true);
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.WHITE_LABEL)).toBe(true);
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.SCIM)).toBe(false);
    });

    it('exposes subject metadata', async () => {
      const token = await issueTestLicense({
        organizationName: 'Universidad Test',
        plan: 'enterprise-plus',
        capabilities: [LICENSE_CAPABILITIES.SSO_SAML],
      });
      await svc.load({ key: token });
      const subj = svc.getSubject();
      expect(subj?.organizationName).toBe('Universidad Test');
      expect(subj?.plan).toBe('enterprise-plus');
    });
  });

  describe('grace state', () => {
    it('reports grace when expired but within grace period', async () => {
      const fixedNow = new Date('2027-04-29T00:00:00Z');
      const token = await issueTestLicense(
        { gracePeriodDays: 30, capabilities: [LICENSE_CAPABILITIES.SCIM] },
        { expiresAt: new Date('2027-04-15T00:00:00Z') }, // 14 días atrás
      );
      const state = await svc.load({ key: token, now: () => fixedNow });
      expect(state.status).toBe('grace');
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.SCIM)).toBe(true);
      expect(state.warnings.length).toBeGreaterThan(0);
    });

    /**
     * Los dos tests de arriba pasaban con el bug: mockean `now`, pero jose
     * validaba `exp` contra el reloj REAL y su fecha (2027-04-15) todavía era
     * futura. El día que llegara, habrían empezado a fallar solos y con ellos
     * se habría destapado que un cliente Enterprise perdía todas sus
     * capabilities en el segundo exacto del vencimiento.
     *
     * Estos usan fechas relativas al reloj de verdad, así que ejercen el
     * camino real: licencia YA vencida, dentro de su gracia.
     */
    it('una licencia vencida DE VERDAD entra en gracia, no en invalid (H17)', async () => {
      const hace5Dias = new Date(Date.now() - 5 * 86_400_000);
      const token = await issueTestLicense(
        { gracePeriodDays: 30, capabilities: [LICENSE_CAPABILITIES.SCIM] },
        { expiresAt: hace5Dias },
      );

      const state = await svc.load({ key: token });

      expect(state.status).toBe('grace');
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.SCIM)).toBe(true);
    });

    it('vencida de verdad y pasada la gracia: expired, no invalid (H17)', async () => {
      const hace90Dias = new Date(Date.now() - 90 * 86_400_000);
      const token = await issueTestLicense(
        { gracePeriodDays: 30, capabilities: [LICENSE_CAPABILITIES.SCIM] },
        { expiresAt: hace90Dias },
      );

      const state = await svc.load({ key: token });

      expect(state.status).toBe('expired');
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.SCIM)).toBe(false);
    });

    it('ceder el control de `exp` NO cede el de la firma: un issuer ajeno sigue siendo invalid', async () => {
      const token = await issueTestLicense(
        { gracePeriodDays: 30 },
        { expiresAt: new Date(Date.now() - 86_400_000), issuer: 'evil.example.com' },
      );

      const state = await svc.load({ key: token });

      expect(state.status).toBe('invalid');
    });
  });

  describe('expired state', () => {
    it('reports expired when past grace period', async () => {
      const fixedNow = new Date('2027-06-29T00:00:00Z');
      const token = await issueTestLicense(
        { gracePeriodDays: 30, capabilities: [LICENSE_CAPABILITIES.SCIM] },
        { expiresAt: new Date('2027-04-15T00:00:00Z') }, // 75 días atrás
      );
      const state = await svc.load({ key: token, now: () => fixedNow });
      expect(state.status).toBe('expired');
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.SCIM)).toBe(false);
    });
  });

  describe('invalid state', () => {
    it('returns invalid when token is malformed', async () => {
      const state = await svc.load({ key: 'not-a-jwt' });
      expect(state.status).toBe('invalid');
      expect(state.warnings[0]).toMatch(/license invalid/i);
    });

    it('reports invalid when token signed with wrong issuer', async () => {
      const token = await issueTestLicense({}, { issuer: 'evil.example.com' });
      const state = await svc.load({ key: token });
      expect(state.status).toBe('invalid');
    });
  });

  describe('dev state', () => {
    const originalEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('enables ALL capabilities under dev bypass when not production', async () => {
      process.env.NODE_ENV = 'development';
      const state = await svc.load({ key: 'whatever', allowDevBypass: true });
      expect(state.status).toBe('dev');
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.MULTI_TENANT_REAL)).toBe(true);
      expect(svc.isCapabilityEnabled(LICENSE_CAPABILITIES.SCIM)).toBe(true);
      expect(svc.isCapabilityEnabled('feat:any.other')).toBe(true);
    });

    it('refuses dev bypass under NODE_ENV=production', async () => {
      process.env.NODE_ENV = 'production';
      const state = await svc.load({ allowDevBypass: true });
      expect(state.status).toBe('community');
    });
  });

  describe('listActiveCapabilities', () => {
    it('returns empty array under community', async () => {
      await svc.load({});
      expect(svc.listActiveCapabilities()).toEqual([]);
    });

    it('returns license capabilities under active', async () => {
      const token = await issueTestLicense({
        capabilities: [LICENSE_CAPABILITIES.SSO_SAML, LICENSE_CAPABILITIES.SSO_OIDC],
      });
      await svc.load({ key: token });
      expect(svc.listActiveCapabilities()).toContain(LICENSE_CAPABILITIES.SSO_SAML);
      expect(svc.listActiveCapabilities()).toContain(LICENSE_CAPABILITIES.SSO_OIDC);
    });
  });
});
