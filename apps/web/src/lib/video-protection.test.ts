import { describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from './api-client';
import {
  PLAY_URL_EXPIRY_MARGIN_MS,
  UNSIGNED_PLAY_URL_TTL_MS,
  WATERMARK_LEFT_RANGE,
  WATERMARK_TOP_BANDS,
  WATERMARK_TOP_RANGE,
  bunnyBaseEmbedUrl,
  bunnyEmbedUrl,
  bunnyRefKey,
  isPlayUrlFresh,
  randomWatermarkPosition,
  watermarkLabel,
  withBunnyPlayerParams,
  withOriginalBunnyParams,
} from './video';
import {
  PlayUrlError,
  createPlayUrlResolver,
  summarizeVideoProtection,
  toPlayUrlError,
  type PlayUrlResponse,
  type VideoProtectionState,
} from './video-protection';

/** Identificadores inventados: no son de ninguna librería real de Bunny. */
const LIB = '100200';
const GUID = '0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b';
const REF = { libraryId: LIB, guid: GUID };
const UNSIGNED = `https://iframe.mediadelivery.net/embed/${LIB}/${GUID}`;
const SIGNED = `${UNSIGNED}?token=5a5de480abc&expires=1900000000`;

describe('withBunnyPlayerParams', () => {
  it('añade los parámetros del reproductor SIN tocar la firma', () => {
    const url = new URL(withBunnyPlayerParams(SIGNED, { startSeconds: 135.7, autoplay: true }));
    expect(url.searchParams.get('token')).toBe('5a5de480abc');
    expect(url.searchParams.get('expires')).toBe('1900000000');
    expect(url.searchParams.get('autoplay')).toBe('true');
    expect(url.searchParams.get('preload')).toBe('true');
    expect(url.searchParams.get('responsive')).toBe('true');
    expect(url.searchParams.get('t')).toBe('135');
    expect(url.pathname).toBe(`/embed/${LIB}/${GUID}`);
  });

  it('sin posición no deja un `t` previo y pone autoplay=false', () => {
    const url = new URL(withBunnyPlayerParams(`${SIGNED}&t=90&autoplay=true`));
    expect(url.searchParams.has('t')).toBe(false);
    expect(url.searchParams.get('autoplay')).toBe('false');
    expect(url.searchParams.get('token')).toBe('5a5de480abc');
  });

  it('COMPATIBILIDAD: sin firma, la URL del iframe es byte a byte la de antes', () => {
    expect(bunnyEmbedUrl({ libraryId: '1', guid: 'abcdef12' })).toBe(
      'https://iframe.mediadelivery.net/embed/1/abcdef12?autoplay=false&preload=true&responsive=true',
    );
    expect(withBunnyPlayerParams(bunnyBaseEmbedUrl(REF), { startSeconds: 42 })).toBe(
      `${UNSIGNED}?autoplay=false&preload=true&responsive=true&t=42`,
    );
  });
});

describe('withOriginalBunnyParams (iframe incrustado a mano en una lección HTML)', () => {
  it('conserva los parámetros que eligió el autor y carga con la firma de la API', () => {
    const original = `${UNSIGNED}?autoplay=false&loop=true&muted=true&preload=false`;
    const url = new URL(withOriginalBunnyParams(SIGNED, original));
    expect(url.searchParams.get('token')).toBe('5a5de480abc');
    expect(url.searchParams.get('expires')).toBe('1900000000');
    expect(url.searchParams.get('loop')).toBe('true');
    expect(url.searchParams.get('muted')).toBe('true');
    expect(url.searchParams.get('autoplay')).toBe('false');
    expect(url.searchParams.get('preload')).toBe('false');
  });

  it('una firma pegada en el HTML nunca pisa la vigente', () => {
    const original = `${UNSIGNED}?token=FIRMA-VIEJA&expires=1&Token=OTRA&loop=true`;
    const url = new URL(withOriginalBunnyParams(SIGNED, original));
    expect(url.searchParams.get('token')).toBe('5a5de480abc');
    expect(url.searchParams.get('expires')).toBe('1900000000');
    expect(url.searchParams.has('Token')).toBe(false);
    expect(url.searchParams.get('loop')).toBe('true');
  });

  it('sin firma (academia sin protección) queda la URL que escribió el autor', () => {
    const original = `${UNSIGNED}?autoplay=true&loop=false`;
    expect(withOriginalBunnyParams(UNSIGNED, original)).toBe(original);
  });

  it('un `src` original ilegible no rompe: se usa la URL de la API', () => {
    expect(withOriginalBunnyParams(SIGNED, 'no es una url')).toBe(SIGNED);
  });
});

describe('isPlayUrlFresh', () => {
  const now = 1_900_000_000_000;
  const entry = (expiresAtMs: number | null, fetchedAtMs = now) => ({
    url: SIGNED,
    expiresAtMs,
    fetchedAtMs,
    watermark: false,
  });

  it('sin entrada en caché hay que pedirla', () => {
    expect(isPlayUrlFresh(undefined, now)).toBe(false);
  });

  it('firma viva más allá del margen: se reutiliza', () => {
    expect(isPlayUrlFresh(entry(now + PLAY_URL_EXPIRY_MARGIN_MS + 1), now)).toBe(true);
  });

  it('firma dentro del margen o caducada: se vuelve a pedir', () => {
    expect(isPlayUrlFresh(entry(now + PLAY_URL_EXPIRY_MARGIN_MS), now)).toBe(false);
    expect(isPlayUrlFresh(entry(now - 1, now - 10), now)).toBe(false);
  });

  it('URL sin firma: vale unos minutos y luego se re-pide (por si se activa la protección)', () => {
    expect(isPlayUrlFresh(entry(null, now - UNSIGNED_PLAY_URL_TTL_MS + 1), now)).toBe(true);
    expect(isPlayUrlFresh(entry(null, now - UNSIGNED_PLAY_URL_TTL_MS), now)).toBe(false);
  });

  it('la clave de caché identifica librería + vídeo, sin distinguir mayúsculas en el GUID', () => {
    expect(bunnyRefKey(REF)).toBe(`${LIB}/${GUID}`);
    expect(bunnyRefKey({ libraryId: LIB, guid: GUID.toUpperCase() })).toBe(`${LIB}/${GUID}`);
    expect(bunnyRefKey({ libraryId: '999', guid: GUID })).not.toBe(bunnyRefKey(REF));
  });
});

describe('randomWatermarkPosition', () => {
  it('se queda siempre dentro de los rangos (lejos de la barra de controles)', () => {
    for (const r of [0, 0.25, 0.5, 0.999, 1, -3, 7]) {
      const { topPct, leftPct } = randomWatermarkPosition(() => r);
      expect(topPct).toBeGreaterThanOrEqual(WATERMARK_TOP_RANGE[0]);
      expect(topPct).toBeLessThanOrEqual(WATERMARK_TOP_RANGE[1]);
      expect(leftPct).toBeGreaterThanOrEqual(WATERMARK_LEFT_RANGE[0]);
      expect(leftPct).toBeLessThanOrEqual(WATERMARK_LEFT_RANGE[1]);
    }
  });

  it('no pasa por el centro: solo la franja de arriba o la de abajo', () => {
    for (const r of [0, 0.1, 0.3, 0.49, 0.5, 0.7, 0.99, 1]) {
      const { topPct } = randomWatermarkPosition(() => r);
      expect(WATERMARK_TOP_BANDS.some(([min, max]) => topPct >= min && topPct <= max)).toBe(true);
      expect(topPct > 20 && topPct < 60).toBe(false);
    }
  });

  it('el tope inferior deja libre el último 20 % (controles del reproductor)', () => {
    expect(WATERMARK_TOP_RANGE[1]).toBeLessThanOrEqual(80);
  });
});

describe('watermarkLabel', () => {
  it('email + los 8 primeros caracteres del id', () => {
    expect(
      watermarkLabel({ email: 'alumna@example.com', id: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }),
    ).toBe('alumna@example.com · 7c9e6679');
  });
});

describe('toPlayUrlError', () => {
  const http = (status: number, code?: string) => new ApiHttpError({ message: 'x', status, code });

  it('VIDEO_FORBIDDEN → sin acceso', () => {
    expect(toPlayUrlError(http(403, 'VIDEO_FORBIDDEN')).kind).toBe('forbidden');
  });

  it('VIDEO_RATE_LIMITED → tope de vídeos', () => {
    expect(toPlayUrlError(http(429, 'VIDEO_RATE_LIMITED')).kind).toBe('rate_limited');
    expect(toPlayUrlError(http(429, 'VIDEO_WATCH_QUOTA')).kind).toBe('watch_quota');
  });

  it('se decide por el code, no por el status: un 403/429 de otra capa no es de vídeo', () => {
    // 429 del límite de peticiones de la academia entera; 403 de MFA pendiente.
    expect(toPlayUrlError(http(429, 'rate_limit_exceeded')).kind).toBe('unknown');
    expect(toPlayUrlError(http(429)).kind).toBe('unknown');
    expect(toPlayUrlError(http(403, 'mfa_required')).kind).toBe('unknown');
    expect(toPlayUrlError(http(403)).kind).toBe('unknown');
  });

  it('cualquier otro error → genérico; un PlayUrlError pasa tal cual', () => {
    expect(toPlayUrlError(new Error('red')).kind).toBe('unknown');
    expect(toPlayUrlError(http(500)).kind).toBe('unknown');
    const already = new PlayUrlError('forbidden');
    expect(toPlayUrlError(already)).toBe(already);
  });
});

// ───────────────────────── resolución de la play-url ─────────────────────────

function makeResolver(playUrl: (ref: typeof REF) => Promise<PlayUrlResponse>) {
  const clock = { now: 1_900_000_000_000 };
  const api = vi.fn(playUrl);
  const resolver = createPlayUrlResolver({ playUrl: api, now: () => clock.now });
  return { resolver, api, clock };
}

const signedResponse = (now: number, minutes = 30): PlayUrlResponse => ({
  url: SIGNED,
  expiresAt: new Date(now + minutes * 60_000).toISOString(),
  protected: true,
  watermark: true,
});

const unsignedResponse: PlayUrlResponse = {
  url: UNSIGNED,
  expiresAt: null,
  protected: false,
  watermark: false,
};

describe('createPlayUrlResolver', () => {
  it('academia protegida: devuelve la URL firmada y la marca de agua que diga la API', async () => {
    const { resolver, clock } = makeResolver(async () => signedResponse(clock.now));
    const entry = await resolver.resolve(REF);
    expect(entry).toEqual({
      url: SIGNED,
      expiresAtMs: clock.now + 30 * 60_000,
      fetchedAtMs: clock.now,
      watermark: true,
    });
  });

  it('COMPATIBILIDAD: academia sin protección → la URL de siempre y sin marca de agua', async () => {
    const { resolver } = makeResolver(async () => unsignedResponse);
    const entry = await resolver.resolve(REF);
    expect(entry.url).toBe(UNSIGNED);
    expect(entry.expiresAtMs).toBeNull();
    expect(entry.watermark).toBe(false);
  });

  it('reutiliza la firma mientras viva: re-montar el reproductor no vuelve a pedirla', async () => {
    const { resolver, api, clock } = makeResolver(async () => signedResponse(clock.now));
    await resolver.resolve(REF);
    clock.now += 10 * 60_000;
    await resolver.resolve(REF);
    expect(resolver.peek(REF)?.url).toBe(SIGNED);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('CADUCIDAD: a un minuto de caducar ya no se monta con ella, se pide otra', async () => {
    const { resolver, api, clock } = makeResolver(async () => signedResponse(clock.now));
    await resolver.resolve(REF);
    clock.now += 29 * 60_000;
    expect(resolver.peek(REF)).toBeUndefined();
    await resolver.resolve(REF);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('comparte la petición en vuelo: dos reproductores del mismo vídeo, una llamada', async () => {
    let release: (value: PlayUrlResponse) => void = () => {};
    const pending = new Promise<PlayUrlResponse>((resolve) => (release = resolve));
    const { resolver, api, clock } = makeResolver(() => pending);
    const first = resolver.resolve(REF);
    const second = resolver.resolve({ libraryId: LIB, guid: GUID.toUpperCase() });
    release(signedResponse(clock.now));
    expect(await first).toBe(await second);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('sin acceso (403 VIDEO_FORBIDDEN): error, y NUNCA la URL sin firmar', async () => {
    const { resolver } = makeResolver(async () => {
      throw new ApiHttpError({ message: 'x', status: 403, code: 'VIDEO_FORBIDDEN' });
    });
    await expect(resolver.resolve(REF)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(resolver.peek(REF)).toBeUndefined();
  });

  it('tope superado (429 VIDEO_RATE_LIMITED): error, y NUNCA la URL sin firmar', async () => {
    const { resolver } = makeResolver(async () => {
      throw new ApiHttpError({ message: 'x', status: 429, code: 'VIDEO_RATE_LIMITED' });
    });
    await expect(resolver.resolve(REF)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('COMPATIBILIDAD: si la API falla (caída, versión sin este endpoint) el vídeo se monta como antes', async () => {
    for (const failure of [
      new TypeError('Failed to fetch'),
      new ApiHttpError({ message: 'Not Found', status: 404 }),
      new ApiHttpError({ message: 'boom', status: 500 }),
    ]) {
      const { resolver, api } = makeResolver(async () => {
        throw failure;
      });
      const entry = await resolver.resolve(REF);
      expect(entry).toMatchObject({ url: UNSIGNED, expiresAtMs: null, watermark: false });
      // No se cachea: el siguiente montaje vuelve a intentarlo con la API.
      expect(resolver.peek(REF)).toBeUndefined();
      await resolver.resolve(REF);
      expect(api).toHaveBeenCalledTimes(2);
    }
  });

  it('sin sesión (el cliente lanza en síncrono) también cae a la URL de siempre', async () => {
    const { resolver } = makeResolver(() => {
      throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
    });
    expect((await resolver.resolve(REF)).url).toBe(UNSIGNED);
  });

  it('si ya se sabe que la librería está protegida, un fallo NO cae a la URL sin firmar', async () => {
    let fail = false;
    const { resolver, clock } = makeResolver(async () => {
      if (fail) throw new ApiHttpError({ message: 'boom', status: 500 });
      return signedResponse(clock.now);
    });
    await resolver.resolve(REF);

    fail = true;
    const other = { libraryId: LIB, guid: '11111111-2222-4333-8444-555555555555' };
    // Otro vídeo de la MISMA librería: sin firma daría la página de error de Bunny.
    await expect(resolver.resolve(other)).rejects.toMatchObject({ kind: 'unknown' });
    // CONTROL: una librería de la que no se sabe nada sí cae a la URL de siempre.
    const elsewhere = { libraryId: '999', guid: other.guid };
    expect((await resolver.resolve(elsewhere)).url).toBe(bunnyBaseEmbedUrl(elsewhere));
  });

  it('si el admin apaga la protección, la librería deja de contarse como protegida', async () => {
    const responses: Array<PlayUrlResponse | Error> = [];
    const { resolver, clock } = makeResolver(async () => {
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    responses.push(
      signedResponse(clock.now, 2),
      unsignedResponse,
      new TypeError('Failed to fetch'),
    );

    await resolver.resolve(REF);
    clock.now += 5 * 60_000;
    expect((await resolver.resolve(REF)).url).toBe(UNSIGNED);
    clock.now += UNSIGNED_PLAY_URL_TTL_MS;
    expect((await resolver.resolve(REF)).url).toBe(UNSIGNED);
  });

  it('una caducidad ilegible se trata como URL sin firma (se re-pide a los pocos minutos)', async () => {
    const { resolver } = makeResolver(async () => ({ ...unsignedResponse, expiresAt: 'ayer' }));
    expect((await resolver.resolve(REF)).expiresAtMs).toBeNull();
  });
});

// ───────────────────────────── resumen del panel ─────────────────────────────

describe('summarizeVideoProtection', () => {
  const base: VideoProtectionState = {
    enabled: true,
    active: false,
    watermark: true,
    limits: { perHour: 30, perDay: 100 },
    libraries: [],
  };
  const lib = (
    configured: boolean,
    outcome?: 'ok' | 'not_enforced' | 'rejected' | 'unreachable',
  ): VideoProtectionState['libraries'][number] => ({
    libraryId: LIB,
    configured,
    inUse: true,
    lastCheck: outcome ? { outcome, checkedAt: '2030-01-01T10:00:00.000Z' } : null,
  });

  it('sin ninguna clave guardada: apagada (aunque el interruptor esté en su valor por defecto)', () => {
    expect(summarizeVideoProtection(base)).toBe('off');
    expect(summarizeVideoProtection({ ...base, libraries: [lib(false)] })).toBe('off');
  });

  it('con clave pero desactivada por el admin', () => {
    expect(
      summarizeVideoProtection({ ...base, enabled: false, libraries: [lib(true, 'ok')] }),
    ).toBe('disabled');
  });

  it('activada y sin comprobar', () => {
    expect(summarizeVideoProtection({ ...base, libraries: [lib(true)] })).toBe('unverified');
  });

  it('activada y comprobada en todas las librerías con clave', () => {
    expect(summarizeVideoProtection({ ...base, libraries: [lib(true, 'ok'), lib(false)] })).toBe(
      'on',
    );
  });

  it('una comprobación que no salió bien manda sobre lo demás', () => {
    for (const outcome of ['not_enforced', 'rejected', 'unreachable'] as const) {
      expect(
        summarizeVideoProtection({ ...base, libraries: [lib(true, 'ok'), lib(true, outcome)] }),
      ).toBe('attention');
    }
    expect(
      summarizeVideoProtection({ ...base, libraries: [lib(true), lib(true, 'rejected')] }),
    ).toBe('attention');
  });
});
