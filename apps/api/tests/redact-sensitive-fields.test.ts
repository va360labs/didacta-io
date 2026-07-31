import { describe, expect, it } from 'vitest';
import { mergeSecretFields, redactSensitiveFields } from '../src/modules/redact-sensitive-fields';

describe('redactSensitiveFields', () => {
  it('redacta el campo password manteniendo los demás (caso SMTP)', () => {
    const input = {
      host: 'smtp.example.com',
      port: 587,
      user: 'noreply@example.com',
      password: 'super-secret',
      from: 'noreply@example.com',
    };
    const out = redactSensitiveFields(input);
    expect(out).toEqual({
      host: 'smtp.example.com',
      port: 587,
      user: 'noreply@example.com',
      password: null,
      from: 'noreply@example.com',
    });
  });

  it('redacta múltiples nombres de credenciales (token, apiKey, secret)', () => {
    const input = {
      provider: 'stripe',
      apiKey: 'sk_live_xxx',
      webhookSecret: 'whsec_xxx',
      refreshToken: 'rt_xxx',
      mode: 'live',
    };
    const out = redactSensitiveFields(input);
    expect(out).toEqual({
      provider: 'stripe',
      apiKey: null,
      webhookSecret: null,
      refreshToken: null,
      mode: 'live',
    });
  });

  it('matching case-insensitive: Password / PASSWORD / password todos se redactan', () => {
    const out = redactSensitiveFields({ Password: 'a', PASSWORD: 'b', password: 'c', host: 'h' });
    expect(out['Password']).toBeNull();
    expect(out['PASSWORD']).toBeNull();
    expect(out['password']).toBeNull();
    expect(out['host']).toBe('h');
  });

  it('matching snake_case y camelCase: api_key + apiKey ambos se redactan', () => {
    const out = redactSensitiveFields({ api_key: 'x', apiKey: 'y', user: 'u' });
    expect(out['api_key']).toBeNull();
    expect(out['apiKey']).toBeNull();
    expect(out['user']).toBe('u');
  });

  it('redacta recursivamente en sub-objetos', () => {
    const input = {
      smtp: { host: 'x', password: 'pw' },
      auth: { token: 't', user: 'u' },
      meta: { description: 'public', nested: { secret: 's', name: 'n' } },
    };
    const out = redactSensitiveFields(input);
    expect(out).toEqual({
      smtp: { host: 'x', password: null },
      auth: { token: null, user: 'u' },
      meta: { description: 'public', nested: { secret: null, name: 'n' } },
    });
  });

  it('preserva arrays sin tocar (asume que no contienen credenciales a nivel array)', () => {
    const input = { hosts: ['a', 'b'], tags: [1, 2, 3], password: 'pw' };
    const out = redactSensitiveFields(input);
    expect(out['hosts']).toEqual(['a', 'b']);
    expect(out['tags']).toEqual([1, 2, 3]);
    expect(out['password']).toBeNull();
  });

  it('preserva null y undefined', () => {
    const out = redactSensitiveFields({ host: null, port: undefined, user: 'u', password: 'p' });
    expect(out['host']).toBeNull();
    expect(out['port']).toBeUndefined();
    expect(out['user']).toBe('u');
    expect(out['password']).toBeNull();
  });

  it('preserva booleans y números', () => {
    const out = redactSensitiveFields({ enabled: true, count: 42, port: 587, password: 'x' });
    expect(out).toEqual({ enabled: true, count: 42, port: 587, password: null });
  });

  it('campo "secret" pelado (sin sufijo) se redacta', () => {
    const out = redactSensitiveFields({ secret: 'x', publicKey: 'pk', name: 'n' });
    expect(out['secret']).toBeNull();
    expect(out['publicKey']).toBe('pk'); // publicKey NO está en la lista
    expect(out['name']).toBe('n');
  });

  it('objeto vacío devuelve objeto vacío', () => {
    expect(redactSensitiveFields({})).toEqual({});
  });
});

describe('mergeSecretFields', () => {
  it('conserva password del previo cuando viene vacío en next (caso típico: admin cambia host sin re-tipear password)', () => {
    const prev = {
      host: 'old.example.com',
      port: 587,
      user: 'user-old',
      password: 'secret-pw',
      from: 'old@example.com',
    };
    const next = {
      host: 'new.example.com',
      port: 587,
      user: 'user-old',
      password: '',
      from: 'old@example.com',
    };
    const merged = mergeSecretFields(prev, next);
    expect(merged).toEqual({
      host: 'new.example.com',
      port: 587,
      user: 'user-old',
      password: 'secret-pw', // ← preservado del previo
      from: 'old@example.com',
    });
  });

  it('sobrescribe password del previo cuando next trae uno nuevo', () => {
    const prev = { user: 'u', password: 'old-pw' };
    const next = { user: 'u', password: 'NEW-PW' };
    const merged = mergeSecretFields(prev, next);
    expect(merged['password']).toBe('NEW-PW');
  });

  it('password null en next preserva el previo', () => {
    const prev = { user: 'u', password: 'old-pw' };
    const next = { user: 'u', password: null };
    expect(mergeSecretFields(prev, next)['password']).toBe('old-pw');
  });

  it('password con whitespace en next se trata como vacío y preserva el previo', () => {
    const prev = { password: 'old-pw' };
    const next = { password: '   ' };
    expect(mergeSecretFields(prev, next)['password']).toBe('old-pw');
  });

  it('campos no sensibles siempre usan next (incluso si next los trae vacíos)', () => {
    const prev = { host: 'old-host', user: 'old-user' };
    const next = { host: '', user: 'new-user' };
    const merged = mergeSecretFields(prev, next);
    expect(merged['host']).toBe(''); // host NO es sensible, se sobrescribe
    expect(merged['user']).toBe('new-user');
  });

  it('mergea recursivamente en sub-objetos preservando secrets de sub-objetos del previo', () => {
    const prev = {
      smtp: { host: 'old-host', password: 'old-pw' },
      stripe: { mode: 'live', apiKey: 'sk_live_old' },
    };
    const next = {
      smtp: { host: 'new-host', password: '' },
      stripe: { mode: 'test', apiKey: '' },
    };
    const merged = mergeSecretFields(prev, next);
    expect(merged).toEqual({
      smtp: { host: 'new-host', password: 'old-pw' },
      stripe: { mode: 'test', apiKey: 'sk_live_old' },
    });
  });

  it('campos sensibles nuevos (no estaban en prev) quedan tal cual vinieron', () => {
    const prev = { host: 'h' };
    const next = { host: 'h', password: 'first-pw' };
    expect(mergeSecretFields(prev, next)['password']).toBe('first-pw');
  });

  it('campo sensible vacío y NO presente en prev queda vacío (no inventa nada)', () => {
    const prev = { host: 'h' };
    const next = { host: 'h', password: '' };
    expect(mergeSecretFields(prev, next)['password']).toBe('');
  });

  it('matching case-insensitive para los campos sensibles', () => {
    const prev = { Password: 'old' };
    const next = { Password: '' };
    expect(mergeSecretFields(prev, next)['Password']).toBe('old');
  });

  it('arrays en next se preservan tal cual (no se mergean)', () => {
    const prev = { hosts: ['a', 'b'], password: 'pw' };
    const next = { hosts: ['c'], password: '' };
    const merged = mergeSecretFields(prev, next);
    expect(merged['hosts']).toEqual(['c']);
    expect(merged['password']).toBe('pw');
  });
});
