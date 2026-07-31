/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heartbeatSchema, type LicenseState } from '@didacta/license-sdk';
import { TelemetryHeartbeatService } from '../src/registry/telemetry-heartbeat.service';

function licenseStub(state: Partial<LicenseState>): { getState: () => LicenseState } {
  return {
    getState: () =>
      ({
        status: 'community',
        loadedAt: new Date(),
        source: 'unknown',
        warnings: [],
        ...state,
      }) as LicenseState,
  };
}

function service(state: Partial<LicenseState> = {}): TelemetryHeartbeatService {
  return new TelemetryHeartbeatService(licenseStub(state) as never);
}

describe('TelemetryHeartbeatService · opt-out y entorno', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('está desactivado en NODE_ENV=test (los tests no hacen ping a nadie)', () => {
    expect(service().enabled()).toBe(false);
  });

  it('DIDACTA_TELEMETRY_DISABLED=true lo apaga aunque no sea test', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DIDACTA_TELEMETRY_DISABLED'] = 'true';
    expect(service().enabled()).toBe(false);
  });

  it('fuera de test y sin flag, está encendido por defecto', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['DIDACTA_TELEMETRY_DISABLED'];
    expect(service().enabled()).toBe(true);
  });
});

describe('TelemetryHeartbeatService · payload', () => {
  let dir: string;
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'didacta-hb-'));
    process.env['STORAGE_ROOT'] = dir;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    rmSync(dir, { recursive: true, force: true });
  });

  it('cumple el schema del SDK y no lleva ni un campo de negocio', () => {
    const hb = service().buildHeartbeat();
    expect(() => heartbeatSchema.parse(hb)).not.toThrow();
    // Contrato de privacidad: SOLO estas claves. Si alguien añade un campo,
    // este test le obliga a pasar por la conversación de privacidad.
    expect(Object.keys(hb).sort()).toEqual([
      'edition',
      'instanceId',
      'node',
      'os',
      'sentAt',
      'version',
    ]);
  });

  it('edición community sin licencia', () => {
    expect(service().buildHeartbeat().edition).toBe('community');
  });

  it('edición = plan cuando hay licencia EE activa', () => {
    const hb = service({
      status: 'active',
      subject: { plan: 'enterprise-annual' } as LicenseState['subject'],
    }).buildHeartbeat();
    expect(hb.edition).toBe('enterprise-annual');
  });

  it('el instanceId se genera una vez y se reutiliza del disco', () => {
    const svc = service();
    const a = svc.instanceId();
    const b = svc.instanceId();
    expect(a).toBe(b);
    expect(readFileSync(join(dir, '.didacta-instance-id'), 'utf8').trim()).toBe(a);
    // Otra instancia del service (otro boot) lee el mismo id.
    expect(service().instanceId()).toBe(a);
  });
});

describe('TelemetryHeartbeatService · envío', () => {
  let dir: string;
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'didacta-hb-'));
    process.env['STORAGE_ROOT'] = dir;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    rmSync(dir, { recursive: true, force: true });
  });

  it('un fallo de red es silencioso: devuelve false y no lanza', async () => {
    const svc = service();
    (svc as never as { client: unknown }).client = {
      sendHeartbeat: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    };
    await expect(svc.sendNow()).resolves.toBe(false);
  });

  it('con receptor accesible, entrega el latido', async () => {
    const svc = service();
    const sendHeartbeat = vi.fn(() => Promise.resolve());
    (svc as never as { client: unknown }).client = { sendHeartbeat };
    await expect(svc.sendNow()).resolves.toBe(true);
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
    const payload = sendHeartbeat.mock.calls[0]![0] as Parameters<typeof heartbeatSchema.parse>[0];
    expect(() => heartbeatSchema.parse(payload)).not.toThrow();
  });
});
