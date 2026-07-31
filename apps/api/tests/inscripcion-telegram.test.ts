import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramService } from '../src/inscripcion/telegram.service';
import type { TelegramGateConfig } from '../src/inscripcion/member-registration-settings.service';
import type { TelegramAuthDto } from '../src/inscripcion/inscripcion.dto';

// ============================================================================
// Tests de TelegramService. Desde los verificadores componibles (F2) el bot es
// config de TENANT: los métodos reciben `TelegramGateConfig` por llamada (la
// resolución setting→env vive en MemberRegistrationSettingsService y se prueba
// aparte). `getChatMember` se prueba mockeando global.fetch (cero red).
// ============================================================================

const BOT_TOKEN = '123456:ABCDEF-test-bot-token';
const GROUP_ID = '-1001234567890';

const CONFIG: TelegramGateConfig = {
  botToken: BOT_TOKEN,
  groupId: GROUP_ID,
  botUsername: 'didacta_test_bot',
};

/** Logger mínimo (nestjs-pino) — solo se invoca .warn en los caminos de error. */
function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function makeService(): TelegramService {
  return new TelegramService(makeLogger());
}

/**
 * Replica el algoritmo del Telegram Login Widget para producir un `hash` VÁLIDO:
 *  - data-check-string = campos != 'hash', valores a string, claves ordenadas
 *    alfabéticamente, unidas por '\n'.
 *  - secret = sha256(botToken) crudo (Buffer de 32 bytes).
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TelegramService', () => {
  describe('verifyLoginHash', () => {
    const nowSeconds = () => Math.floor(Date.now() / 1000);

    it('true con un hash válido y auth_date reciente', () => {
      const svc = makeService();
      const base = {
        id: '424242',
        first_name: 'Ana',
        username: 'ana',
        auth_date: nowSeconds(),
      };
      const hash = computeValidHash(base);
      const fields = { ...base, hash } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(CONFIG, fields)).toBe(true);
    });

    it('false con un hash inválido (manipulado)', () => {
      const svc = makeService();
      const base = { id: '424242', auth_date: nowSeconds() };
      const valid = computeValidHash(base);
      // Volteamos un carácter del hash manteniendo la longitud (hex).
      const tampered = (valid[0] === 'a' ? 'b' : 'a') + valid.slice(1);
      const fields = { ...base, hash: tampered } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(CONFIG, fields)).toBe(false);
    });

    it('false con un hash calculado con OTRO bot token', () => {
      const svc = makeService();
      const base = { id: '424242', auth_date: nowSeconds() };
      const hash = computeValidHash(base, 'otro:token-distinto');
      const fields = { ...base, hash } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(CONFIG, fields)).toBe(false);
    });

    it('false con auth_date viejo (> 86400s)', () => {
      const svc = makeService();
      const base = { id: '424242', auth_date: nowSeconds() - 86401 };
      const hash = computeValidHash(base);
      const fields = { ...base, hash } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(CONFIG, fields)).toBe(false);
    });

    it('false con auth_date en el futuro lejano (> 86400s)', () => {
      const svc = makeService();
      const base = { id: '424242', auth_date: nowSeconds() + 86401 };
      const hash = computeValidHash(base);
      const fields = { ...base, hash } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(CONFIG, fields)).toBe(false);
    });

    it('false si auth_date no es finito', () => {
      const svc = makeService();
      const fields = {
        id: '1',
        auth_date: Number.NaN,
        hash: 'deadbeef',
      } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(CONFIG, fields)).toBe(false);
    });

    it('false si falta el hash', () => {
      const svc = makeService();
      const fields = { id: '1', auth_date: nowSeconds() } as unknown as TelegramAuthDto;
      expect(svc.verifyLoginHash(CONFIG, fields)).toBe(false);
    });

    it('false con una config sin botToken', () => {
      const svc = makeService();
      const fields = {
        id: '1',
        auth_date: nowSeconds(),
        hash: 'deadbeef',
      } as unknown as TelegramAuthDto;
      expect(
        svc.verifyLoginHash({ botToken: '', groupId: GROUP_ID, botUsername: null }, fields),
      ).toBe(false);
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
      expect(await makeService().getChatMember(CONFIG, '424242')).toBe('true');
    });

    it("'true' cuando el status es 'creator' o 'administrator'", async () => {
      stubFetch({ ok: true, result: { status: 'creator' } });
      expect(await makeService().getChatMember(CONFIG, '1')).toBe('true');

      stubFetch({ ok: true, result: { status: 'administrator' } });
      expect(await makeService().getChatMember(CONFIG, '1')).toBe('true');
    });

    it("'false' cuando el status es 'left'", async () => {
      stubFetch({ ok: true, result: { status: 'left' } });
      expect(await makeService().getChatMember(CONFIG, '424242')).toBe('false');
    });

    it("'false' cuando el status es 'kicked'", async () => {
      stubFetch({ ok: true, result: { status: 'kicked' } });
      expect(await makeService().getChatMember(CONFIG, '424242')).toBe('false');
    });

    it("'false' cuando ok=false con descripción 'user not found'", async () => {
      stubFetch({ ok: false, description: 'Bad Request: user not found' });
      expect(await makeService().getChatMember(CONFIG, '424242')).toBe('false');
    });

    it("'unknown' cuando el status es desconocido", async () => {
      stubFetch({ ok: true, result: { status: 'restricted' } });
      expect(await makeService().getChatMember(CONFIG, '424242')).toBe('unknown');
    });

    it("'unknown' cuando ok=false con otra descripción", async () => {
      stubFetch({ ok: false, description: 'Too Many Requests' });
      expect(await makeService().getChatMember(CONFIG, '424242')).toBe('unknown');
    });

    it("'unknown' cuando la respuesta HTTP no es ok", async () => {
      stubFetch({}, false, 500);
      expect(await makeService().getChatMember(CONFIG, '424242')).toBe('unknown');
    });

    it("'unknown' cuando fetch lanza (timeout/red)", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('The operation was aborted'));
      vi.stubGlobal('fetch', fetchMock);
      expect(await makeService().getChatMember(CONFIG, '424242')).toBe('unknown');
    });

    it("'unknown' con config incompleta (no llama a la red)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const svc = makeService();
      expect(
        await svc.getChatMember({ botToken: '', groupId: GROUP_ID, botUsername: null }, '424242'),
      ).toBe('unknown');
      expect(
        await svc.getChatMember({ botToken: BOT_TOKEN, groupId: '', botUsername: null }, '424242'),
      ).toBe('unknown');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
