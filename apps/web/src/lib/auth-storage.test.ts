import { beforeEach, describe, expect, it } from 'vitest';
import { authStorage } from './auth-storage';

/**
 * `auth-storage` habla con `localStorage`/`sessionStorage` y con `window`, que
 * en el entorno node de vitest no existen. Montamos un doble mínimo (el
 * proyecto no tiene jsdom) — es suficiente porque el módulo solo usa
 * getItem/setItem/removeItem.
 */
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

const ACCESS_KEY = 'didacta.access_token';
const REFRESH_KEY = 'didacta.refresh_token';
const SESSION_KEY = 'didacta.session';

const SESSION = {
  user: {
    id: 'u1',
    email: 'alumno@va360labs.com',
    name: 'Alumno',
    tenantId: 't1',
    tenantSlug: 'va360',
    roles: ['alumno'],
    mfaEnabled: false,
  },
  mfaRequired: false,
};

let local: FakeStorage;
let session: FakeStorage;

beforeEach(() => {
  local = new FakeStorage();
  session = new FakeStorage();
  Object.assign(globalThis, {
    window: globalThis,
    localStorage: local,
    sessionStorage: session,
  });
});

describe('authStorage — "Mantener la sesión abierta"', () => {
  it('marcado: tokens y sesión en localStorage, sobreviven al cierre de la pestaña', () => {
    authStorage.saveTokens('acc', 'ref', true);
    authStorage.saveSession(SESSION, true);

    expect(local.getItem(ACCESS_KEY)).toBe('acc');
    expect(local.getItem(REFRESH_KEY)).toBe('ref');
    expect(local.getItem(SESSION_KEY)).not.toBeNull();
    expect(session.getItem(ACCESS_KEY)).toBeNull();
    expect(session.getItem(REFRESH_KEY)).toBeNull();
    expect(session.getItem(SESSION_KEY)).toBeNull();
  });

  it('desmarcado: todo en sessionStorage — al cerrar la pestaña no queda nada', () => {
    authStorage.saveTokens('acc', 'ref', false);
    authStorage.saveSession(SESSION, false);

    expect(session.getItem(ACCESS_KEY)).toBe('acc');
    expect(session.getItem(REFRESH_KEY)).toBe('ref');
    expect(session.getItem(SESSION_KEY)).not.toBeNull();
    expect(local.getItem(ACCESS_KEY)).toBeNull();
    expect(local.getItem(REFRESH_KEY)).toBeNull();
    expect(local.getItem(SESSION_KEY)).toBeNull();
  });

  it('la app lee igual en los dos modos', () => {
    authStorage.saveTokens('acc', 'ref', false);
    authStorage.saveSession(SESSION, false);

    expect(authStorage.getAccessToken()).toBe('acc');
    expect(authStorage.getRefreshToken()).toBe('ref');
    expect(authStorage.getSession()?.user.email).toBe('alumno@va360labs.com');
  });

  it('los pasos posteriores al login (MFA, onboarding) NO promueven la sesión a persistente', () => {
    authStorage.saveTokens('acc', 'ref', false);
    authStorage.saveSession(SESSION, false);

    // Sin flag explícito: verificar el segundo factor reescribe los tokens.
    authStorage.saveTokens('acc2', 'ref2');
    authStorage.saveSession(SESSION);

    expect(session.getItem(ACCESS_KEY)).toBe('acc2');
    expect(local.getItem(ACCESS_KEY)).toBeNull();
    expect(local.getItem(SESSION_KEY)).toBeNull();
  });

  it('sin sesión previa y sin flag, el default es persistente', () => {
    authStorage.saveTokens('acc', 'ref');
    expect(local.getItem(ACCESS_KEY)).toBe('acc');
    expect(session.getItem(ACCESS_KEY)).toBeNull();
  });

  it('volver a entrar CON "mantener abierta" no deja restos en sessionStorage', () => {
    authStorage.saveTokens('viejo', 'viejo-ref', false);
    authStorage.saveSession(SESSION, false);

    authStorage.saveTokens('nuevo', 'nuevo-ref', true);
    authStorage.saveSession(SESSION, true);

    expect(session.getItem(ACCESS_KEY)).toBeNull();
    expect(session.getItem(REFRESH_KEY)).toBeNull();
    expect(session.getItem(SESSION_KEY)).toBeNull();
    expect(authStorage.getAccessToken()).toBe('nuevo');
  });

  it('clear() vacía los dos almacenes', () => {
    authStorage.saveTokens('acc', 'ref', false);
    authStorage.saveSession(SESSION, false);
    authStorage.clear();

    expect(authStorage.getAccessToken()).toBeNull();
    expect(authStorage.getRefreshToken()).toBeNull();
    expect(authStorage.getSession()).toBeNull();
    expect(local.length).toBe(0);
    expect(session.length).toBe(0);
  });
});
