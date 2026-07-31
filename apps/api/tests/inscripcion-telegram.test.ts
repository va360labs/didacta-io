import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramService } from '../src/inscripcion/telegram.service';
import type { TelegramAuthDto } from '../src/inscripcion/inscripcion.dto';

// ============================================================================
// Tests de TelegramService. El servicio lee BOT_TOKEN / GROUP_ID / BOT_USERNAME
// de process.env en `const` a nivel de módulo, por eso seteamos el env ANTES de
// importarlo y usamos vi.resetModules() + import dinámico para controlar la
// config por test. `getChatMember` se prueba mockeando global.fetch (cero red).
// ============================================================================

const BOT_TOKEN = '123456:ABCDEF-test-bot-token';
const GROUP_ID = '-1001234567890';
const BOT_USERNAME = 'didacta_test_bot';

/** Logger mínimo (nestjs-pino) — solo se invoca .warn en los caminos de error. */
function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

/**
 * Importa una instancia fresca de TelegramService con el env ya configurado.
 * Resetea el caché de módulos para que los `const` de config se relean.
 */
async function loadService(): Promise<TelegramService> {
  vi.resetModules();
  const mod = await import('../src/inscripcion/telegram.service');
  return new mod.TelegramService(makeLogger());
}

/**
 * Replica el algoritmo del Telegram Login Widget para producir un `hash` VÁLIDO:
 *  - data-check-string = campos != 'hash', valores a string, claves ordenadas
 *    alfabéticamente, unidas por '\n'.
 *  - secret = sha256(BOT_TOKEN) crudo (Buffer de 32 bytes).
 *  - hash = HMAC-SHA256(secret, dcs) en hex.
 */
function computeValidHash(fields: Record<string, string | number>, botToken = BOT_TOKEN): string {
  const dcs = Object.entries(fields)
    .filter(([key, value]) => key !== 'hash' && value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  return createHmac('sha256', secret).update(dcs).digest('hex');
}

const ORIGINAL_ENV = {
  TELEGRAM_BOT_TOKEN: process.env['TELEGRAM_BOT_TOKEN'],
  TELEGRAM_GROUP_ID: process.env['TELEGRAM_GROUP_ID'],
  TELEGRAM_BOT_USERNAME: process.env['TELEGRAM_BOT_USERNAME'],
};

beforeEach(() => {
  process.env['TELEGRAM_BOT_TOKEN'] = BOT_TOKEN;
  process.env['TELEGRAM_GROUP_ID'] = GROUP_ID;
  process.env['TELEGRAM_BOT_USERNAME'] = BOT_USERNAME;
});

afterEach(() => {
  // Restaura el env original y los mocks globales.
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TelegramService', () => {
  describe('isConfigured', () => {
    it('true cuando hay BOT_TOKEN y GROUP_ID', async () => {
      const svc = await loadService();
      expect(svc.isConfigured()).toBe(true);
    });

    it('false cuando falta el BOT_TOKEN', async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      const svc = await loadService();
      expect(svc.isConfigured()).toBe(false);
    });

    it('false cuando falta el GROUP_ID', async () => {
      delete process.env['TELEGRAM_GROUP_ID'];
      const svc = await loadService();
      expect(svc.isConfigured()).toBe(false);
    });
  });

  describe('botUsername', () => {
    it('devuelve el username configurado (sin @)', async () => {
      const svc = await loadService();
      expect(svc.botUsername).toBe(BOT_USERNAME);
    });

    it('null cuando no está configurado', async () => {
      delete process.env['TELEGRAM_BOT_USERNAME'];
      const svc = await loadService();
      expect(svc.botUsername).toBeNull();
    });
  });

  describe('verifyLoginHash', () => {
    const nowSeconds = () => Math.floor(Date.now() / 1000);

    it('true con un hash válido y auth_date reciente', async () => {
      const svc = await loadService();
      const base = {
        id: '424242',
        first_name: 'Ana',
        username: 'ana',
        auth_date: nowSeconds(),
      };
      const hash = computeValidHash(base);
      const fields = { ...base, hash } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(fields)).toBe(true);
    });

    it('false con un hash inválido (manipulado)', async () => {
      const svc = await loadService();
      const base = { id: '424242', auth_date: nowSeconds() };
      const valid = computeValidHash(base);
      // Volteamos un carácter del hash manteniendo la longitud (hex).
      const tampered = (valid[0] === 'a' ? 'b' : 'a') + valid.slice(1);
      const fields = { ...base, hash: tampered } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(fields)).toBe(false);
    });

    it('false con un hash calculado con OTRO bot token', async () => {
      const svc = await loadService();
      const base = { id: '424242', auth_date: nowSeconds() };
      const hash = computeValidHash(base, 'otro:token-distinto');
      const fields = { ...base, hash } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(fields)).toBe(false);
    });

    it('false con auth_date viejo (> 86400s)', async () => {
      const svc = await loadService();
      const base = { id: '424242', auth_date: nowSeconds() - 86401 };
      const hash = computeValidHash(base);
      const fields = { ...base, hash } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(fields)).toBe(false);
    });

    it('false con auth_date en el futuro lejano (> 86400s)', async () => {
      const svc = await loadService();
      const base = { id: '424242', auth_date: nowSeconds() + 86401 };
      const hash = computeValidHash(base);
      const fields = { ...base, hash } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(fields)).toBe(false);
    });

    it('false si auth_date no es finito', async () => {
      const svc = await loadService();
      const fields = {
        id: '1',
        auth_date: Number.NaN,
        hash: 'deadbeef',
      } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(fields)).toBe(false);
    });

    it('false si falta el hash', async () => {
      const svc = await loadService();
      const fields = { id: '1', auth_date: nowSeconds() } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(fields)).toBe(false);
    });

    it('false cuando no hay BOT_TOKEN configurado', async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      const svc = await loadService();
      const fields = {
        id: '1',
        auth_date: nowSeconds(),
        hash: 'deadbeef',
      } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(fields)).toBe(false);
    });
  });

  describe('getChatMember', () => {
    /** Mockea global.fetch con una respuesta JSON controlada. */
    function stubFetch(json: unknown, ok = true, status = 200) {
      const fetchMock = vi.fn().mockResolvedValue({
        ok,
        status,
        json: () => Promise.resolve(json),
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it("'true' cuando el status es 'member'", async () => {
      stubFetch({ ok: true, result: { status: 'member' } });
      const svc = await loadService();
      expect(await svc.getChatMember('424242')).toBe('true');
    });

    it("'true' cuando el status es 'creator' o 'administrator'", async () => {
      stubFetch({ ok: true, result: { status: 'creator' } });
      const svc1 = await loadService();
      expect(await svc1.getChatMember('1')).toBe('true');

      stubFetch({ ok: true, result: { status: 'administrator' } });
      const svc2 = await loadService();
      expect(await svc2.getChatMember('1')).toBe('true');
    });

    it("'false' cuando el status es 'left'", async () => {
      stubFetch({ ok: true, result: { status: 'left' } });
      const svc = await loadService();
      expect(await svc.getChatMember('424242')).toBe('false');
    });

    it("'false' cuando el status es 'kicked'", async () => {
      stubFetch({ ok: true, result: { status: 'kicked' } });
      const svc = await loadService();
      expect(await svc.getChatMember('424242')).toBe('false');
    });

    it("'false' cuando ok=false con descripción 'user not found'", async () => {
      stubFetch({ ok: false, description: 'Bad Request: user not found' });
      const svc = await loadService();
      expect(await svc.getChatMember('424242')).toBe('false');
    });

    it("'unknown' cuando el status es desconocido", async () => {
      stubFetch({ ok: true, result: { status: 'restricted' } });
      const svc = await loadService();
      expect(await svc.getChatMember('424242')).toBe('unknown');
    });

    it("'unknown' cuando ok=false con otra descripción", async () => {
      stubFetch({ ok: false, description: 'Too Many Requests' });
      const svc = await loadService();
      expect(await svc.getChatMember('424242')).toBe('unknown');
    });

    it("'unknown' cuando la respuesta HTTP no es ok", async () => {
      stubFetch({}, false, 500);
      const svc = await loadService();
      expect(await svc.getChatMember('424242')).toBe('unknown');
    });

    it("'unknown' cuando fetch lanza (timeout/red)", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('The operation was aborted'));
      vi.stubGlobal('fetch', fetchMock);
      const svc = await loadService();
      expect(await svc.getChatMember('424242')).toBe('unknown');
    });

    it("'unknown' cuando no hay configuración (no llama a la red)", async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const svc = await loadService();
      expect(await svc.getChatMember('424242')).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
