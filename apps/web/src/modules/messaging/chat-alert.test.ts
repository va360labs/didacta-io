import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Preferencia del aviso sonoro del chat flotante. Sin DOM real: se inyecta un
 * `window` mínimo, que es todo lo que toca este módulo.
 *
 * Lo que importa aquí es el DEFECTO y la degradación: un almacenamiento
 * bloqueado (modo privado, cookies de terceros) no puede dejar al usuario sin
 * avisos ni reventar el shell.
 */

const store = new Map<string, string>();

function installWindow(storage: Partial<Storage>) {
  vi.stubGlobal('window', {
    localStorage: storage,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

const workingStorage: Partial<Storage> = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
};

beforeEach(() => {
  store.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadModule() {
  return import('./chat-alert');
}

describe('preferencia del aviso sonoro', () => {
  it('suena por defecto: sin preferencia guardada, el aviso está activo', async () => {
    installWindow(workingStorage);
    const { isChatSoundEnabled } = await loadModule();
    expect(isChatSoundEnabled()).toBe(true);
  });

  it('se puede silenciar y persiste', async () => {
    installWindow(workingStorage);
    const { isChatSoundEnabled, setChatSoundEnabled } = await loadModule();
    setChatSoundEnabled(false);
    expect(store.get('didacta:chat-flotante:sonido')).toBe('0');
    expect(isChatSoundEnabled()).toBe(false);
  });

  it('se puede volver a activar', async () => {
    installWindow(workingStorage);
    const { isChatSoundEnabled, setChatSoundEnabled } = await loadModule();
    setChatSoundEnabled(false);
    setChatSoundEnabled(true);
    expect(isChatSoundEnabled()).toBe(true);
  });

  it('con el almacenamiento bloqueado sigue avisando en vez de quedarse mudo', async () => {
    installWindow({
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    });
    const { isChatSoundEnabled, setChatSoundEnabled } = await loadModule();
    expect(isChatSoundEnabled()).toBe(true);
    // Y guardar la preferencia no puede tumbar nada.
    expect(() => setChatSoundEnabled(false)).not.toThrow();
  });

  it('en servidor (sin window) no suena ni explota', async () => {
    vi.stubGlobal('window', undefined);
    const { isChatSoundEnabled, playChatChime, primeChatSound } = await loadModule();
    expect(isChatSoundEnabled()).toBe(false);
    expect(() => playChatChime()).not.toThrow();
    expect(() => primeChatSound()()).not.toThrow();
  });

  it('sin WebAudio en el navegador, el tono se descarta sin romper el aviso visual', async () => {
    installWindow(workingStorage);
    const { playChatChime } = await loadModule();
    expect(() => playChatChime()).not.toThrow();
  });
});
