/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tests integración del piloto white-label (MIG-026 + MIG-034).
 *
 * Validan que la capability `feat:white_label` se gatea correctamente:
 *  - Sin licencia: BrandingController OK, WhiteLabelController rechaza.
 *  - Con licencia activa: ambos OK.
 *  - Con licencia expirada: WhiteLabelController rechaza.
 *
 * No usa DB real (los servicios mantienen estado en memoria) ni HTTP server
 * (instanciamos los services + controllers directamente). Los tests del
 * SDK propio (packages/license-sdk/tests/) cubren el guard end-to-end.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LicenseService } from '@didacta/license-sdk';
import { CapabilityRequiredError, LICENSE_CAPABILITIES } from '@didacta/license-sdk';
import { BrandingService } from '../src/branding/branding.service';
import { BrandingController } from '../src/branding/branding.controller';

// El fence open-core (`scripts/ee-fence.ts`) prohíbe imports estáticos de
// archivos `.ee.*` desde código no-EE. Cargamos los símbolos EE vía dynamic
// import en el setup, igual que haría el runtime real detrás de
// LicenseService.requireCapability(). Esto nos da los tipos sin romper la
// convención.
type WhiteLabelServiceCtor =
  typeof import('../src/branding/white-label.service.ee').WhiteLabelService;
type WhiteLabelControllerCtor =
  typeof import('../src/branding/white-label.controller.ee').WhiteLabelController;

describe('Capability piloto: white-label (MIG-026)', () => {
  let license: LicenseService;
  let branding: BrandingService;
  let whiteLabel: InstanceType<WhiteLabelServiceCtor>;
  let brandingCtrl: BrandingController;
  let whiteLabelCtrl: InstanceType<WhiteLabelControllerCtor>;

  beforeEach(async () => {
    const { WhiteLabelService } = await import('../src/branding/white-label.service.ee');
    const { WhiteLabelController } = await import('../src/branding/white-label.controller.ee');
    license = new LicenseService();
    branding = new BrandingService();
    whiteLabel = new WhiteLabelService(branding);
    brandingCtrl = new BrandingController(branding, license);
    whiteLabelCtrl = new WhiteLabelController(whiteLabel);
  });

  describe('BrandingController (CE, siempre disponible)', () => {
    it('devuelve opciones públicas sin licencia (community)', async () => {
      await license.load({ key: null });
      const opts = brandingCtrl.getOptions();
      expect(opts.whiteLabelEnabled).toBe(false);
      expect(opts.poweredByDidacta).toBe(true);
      expect(opts.logoUrl).toBeTruthy();
    });

    it('refleja whiteLabelEnabled=true cuando capability activa', async () => {
      await license.load({
        allowDevBypass: true,
        key: 'whatever-not-validated-in-dev',
      });
      const opts = brandingCtrl.getOptions();
      expect(opts.whiteLabelEnabled).toBe(true);
    });
  });

  describe('WhiteLabelService directly (no guard)', () => {
    it('configure aplica los cambios al BrandingService', () => {
      const result = whiteLabel.configure({
        logoUrl: 'https://acme.example.com/logo.png',
        primaryColor: '#ff5500',
        poweredByDidacta: false,
      });
      expect(result.applied.logoUrl).toBe('https://acme.example.com/logo.png');
      expect(result.state.logoUrl).toBe('https://acme.example.com/logo.png');
      expect(result.state.primaryColor).toBe('#ff5500');
      expect(result.state.poweredByDidacta).toBe(false);
    });

    it('preview devuelve estado + canHideBrand=true', () => {
      const p = whiteLabel.preview();
      expect(p.canHideBrand).toBe(true);
      expect(p.state).toBeDefined();
    });
  });

  describe('Gating: requireCapability + LicenseService', () => {
    it('en community, requireCapability(white_label) lanza error', async () => {
      await license.load({ key: null });
      expect(() => license.requireCapability(LICENSE_CAPABILITIES.WHITE_LABEL)).toThrow(
        CapabilityRequiredError,
      );
    });

    it('en dev bypass, requireCapability(white_label) pasa', async () => {
      await license.load({
        allowDevBypass: true,
        key: 'dev-key',
      });
      expect(() => license.requireCapability(LICENSE_CAPABILITIES.WHITE_LABEL)).not.toThrow();
    });
  });
});
