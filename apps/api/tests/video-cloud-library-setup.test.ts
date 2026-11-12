/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BunnyAccountClient,
  DESIRED_RESOLUTIONS,
  planLibrarySetup,
} from '../src/video/cloud/bunny-library-setup';

const env = {
  apiKey: 'api-key',
  webhookSecret: 'read-only',
  tokenKey: 'token-key',
  cdnHostname: 'vz-abc.b-cdn.net',
};
const WEBHOOK = 'https://api.didacta.io/api/v1/video/bunny/webhook';

describe('ajustes de la biblioteca de Cloud', () => {
  it('una biblioteca recién creada: todo por cambiar', () => {
    const plan = planLibrarySetup({
      library: {
        EnabledResolutions: '240p,360p,480p,720p,1080p,1440p,2160p',
        KeepOriginalFiles: true,
        EnableMP4Fallback: true,
        AllowDirectPlay: true,
        PlayerTokenAuthenticationEnabled: false,
        WebhookUrl: null,
        ApiKey: 'api-key',
        ReadOnlyApiKey: 'read-only',
      },
      pullZone: {
        Type: 0,
        ZoneSecurityEnabled: false,
        ZoneSecurityKey: 'token-key',
        EdgeRules: [],
        Hostnames: [{ Value: 'vz-abc.b-cdn.net' }],
      },
      webhookUrl: WEBHOOK,
      env,
    });
    expect(plan.library).toEqual({
      EnabledResolutions: DESIRED_RESOLUTIONS,
      KeepOriginalFiles: false,
      EnableMP4Fallback: false,
      AllowDirectPlay: false,
      PlayerTokenAuthenticationEnabled: true,
      EnableTokenAuthentication: true,
      WebhookUrl: WEBHOOK,
    });
    expect(plan.pullZone).toEqual({ Type: 1 });
    expect(plan.edgeRules.map((r) => r['Description'])).toEqual(['block_original', 'block_mp4']);
    expect(plan.edgeRules[0]).toMatchObject({
      ActionType: 4,
      Triggers: [{ Type: 0, PatternMatches: ['*/original*'], PatternMatchingType: 0 }],
    });
    expect(plan.checks.every((c) => c.ok)).toBe(true);
  });

  it('ya bien puesta: nada que cambiar (control)', () => {
    const plan = planLibrarySetup({
      library: {
        EnabledResolutions: DESIRED_RESOLUTIONS,
        KeepOriginalFiles: false,
        EnableMP4Fallback: false,
        AllowDirectPlay: false,
        PlayerTokenAuthenticationEnabled: true,
        WebhookUrl: WEBHOOK,
        ApiKey: 'api-key',
        ReadOnlyApiKey: 'read-only',
      },
      pullZone: {
        Type: 'Volume',
        ZoneSecurityEnabled: true,
        ZoneSecurityKey: 'token-key',
        EdgeRules: [
          { Description: 'block_original', ActionType: 4, Enabled: true },
          { Description: 'block_mp4', ActionType: 'BlockRequest', Enabled: true },
        ],
        Hostnames: [{ Value: 'VZ-abc.b-cdn.net' }],
      },
      webhookUrl: WEBHOOK,
      env,
    });
    expect(plan.library).toEqual({});
    expect(plan.pullZone).toEqual({});
    expect(plan.edgeRules).toEqual([]);
  });

  it('el token de la CDN se lee en la zona: la biblioteca no devuelve EnableTokenAuthentication', () => {
    // Forma real de `GET /videolibrary/{id}`: sin el campo de escritura.
    const library = {
      EnabledResolutions: DESIRED_RESOLUTIONS,
      KeepOriginalFiles: false,
      EnableMP4Fallback: false,
      AllowDirectPlay: false,
      PlayerTokenAuthenticationEnabled: true,
      WebhookUrl: WEBHOOK,
      ApiKey: 'api-key',
      ReadOnlyApiKey: 'read-only',
    };
    const rules = [
      { Description: 'block_original', ActionType: 4, Enabled: true },
      { Description: 'block_mp4', ActionType: 4, Enabled: true },
    ];
    const off = planLibrarySetup({
      library,
      pullZone: {
        Type: 1,
        ZoneSecurityEnabled: false,
        ZoneSecurityKey: 'token-key',
        EdgeRules: rules,
      },
      webhookUrl: WEBHOOK,
      env,
    });
    expect(off.library).toEqual({ EnableTokenAuthentication: true });
    const on = planLibrarySetup({
      library,
      pullZone: {
        Type: 1,
        ZoneSecurityEnabled: true,
        ZoneSecurityKey: 'token-key',
        EdgeRules: rules,
      },
      webhookUrl: WEBHOOK,
      env,
    });
    expect(on.library).toEqual({});
  });

  it('variables equivocadas: lo dice, sin imprimir ninguna clave', () => {
    const plan = planLibrarySetup({
      library: { ApiKey: 'otra-api-key', ReadOnlyApiKey: 'otra' },
      pullZone: { ZoneSecurityKey: 'otra-token', Hostnames: [{ Value: 'vz-zzz.b-cdn.net' }] },
      webhookUrl: WEBHOOK,
      env,
    });
    expect(plan.checks.map((c) => c.ok)).toEqual([false, false, false, false]);
    const text = JSON.stringify(plan.checks);
    for (const secret of ['api-key', 'read-only', 'token-key', 'otra-api-key', 'otra-token']) {
      expect(text).not.toContain(secret);
    }
  });

  it('el cliente de cuenta llama a la API core con la clave de cuenta', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{"PullZoneId":5}', { status: 200 }));
    const client = new BunnyAccountClient('cuenta', f as unknown as typeof fetch);
    expect(await client.getLibrary('700900')).toEqual({ PullZoneId: 5 });
    expect(f).toHaveBeenCalledWith(
      'https://api.bunny.net/videolibrary/700900',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ AccessKey: 'cuenta' }),
      }),
    );
    f.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await expect(client.updateLibrary('700900', {})).rejects.toThrow(/401/);
  });
});
