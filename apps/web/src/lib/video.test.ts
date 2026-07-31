import { describe, expect, it } from 'vitest';
import {
  advanceWatch,
  breakWatchContinuity,
  bunnyEmbedUrl,
  formatSeconds,
  initWatchState,
  parseBunny,
  parseResources,
  parseTimestampToSeconds,
  parseYouTubeId,
  parseYouTubeStartSeconds,
  watchedPercent,
  youTubeEmbedUrl,
} from './video';

describe('parseYouTubeId', () => {
  it('detecta youtube.com/watch?v=ID', () => {
    expect(parseYouTubeId('https://www.youtube.com/watch?v=abc123XYZ')).toBe('abc123XYZ');
  });
  it('detecta youtu.be/ID', () => {
    expect(parseYouTubeId('https://youtu.be/abc123XYZ')).toBe('abc123XYZ');
  });
  it('detecta youtube.com/shorts/ID', () => {
    expect(parseYouTubeId('https://www.youtube.com/shorts/abc123XYZ')).toBe('abc123XYZ');
  });
  it('detecta el dominio nocookie', () => {
    expect(parseYouTubeId('https://www.youtube-nocookie.com/embed/abc123XYZ')).toBe('abc123XYZ');
  });
  it('null para URLs no-YouTube', () => {
    expect(parseYouTubeId('https://vimeo.com/12345')).toBeNull();
    expect(parseYouTubeId('https://my-cdn.com/video.mp4')).toBeNull();
  });
  it('null para strings inválidos', () => {
    expect(parseYouTubeId('')).toBeNull();
    expect(parseYouTubeId('not-a-url')).toBeNull();
  });
});

describe('parseYouTubeStartSeconds', () => {
  it('parsea t=42s', () => {
    expect(parseYouTubeStartSeconds('https://youtu.be/abc?t=42s')).toBe(42);
  });
  it('parsea t=1m30s', () => {
    expect(parseYouTubeStartSeconds('https://youtu.be/abc?t=1m30s')).toBe(90);
  });
  it('parsea t=1h2m3s', () => {
    expect(parseYouTubeStartSeconds('https://youtu.be/abc?t=1h2m3s')).toBe(3723);
  });
  it('parsea t=42 (segundos puros)', () => {
    expect(parseYouTubeStartSeconds('https://youtu.be/abc?t=42')).toBe(42);
  });
  it('parsea start= como alias', () => {
    expect(parseYouTubeStartSeconds('https://youtu.be/abc?start=15')).toBe(15);
  });
  it('undefined si no hay timestamp', () => {
    expect(parseYouTubeStartSeconds('https://youtu.be/abc')).toBeUndefined();
  });
});

describe('youTubeEmbedUrl', () => {
  it('devuelve URL de embed nocookie', () => {
    expect(youTubeEmbedUrl('abc123')).toBe('https://www.youtube-nocookie.com/embed/abc123?rel=0');
  });
  it('incluye start= cuando se pasa startSeconds', () => {
    expect(youTubeEmbedUrl('abc123', { startSeconds: 90 })).toBe(
      'https://www.youtube-nocookie.com/embed/abc123?start=90&rel=0',
    );
  });
});

describe('parseBunny', () => {
  it('detecta la URL de embed de Bunny Stream', () => {
    expect(
      parseBunny(
        'https://iframe.mediadelivery.net/embed/12345/9b8c7d6e-1111-2222-3333-444455556666',
      ),
    ).toEqual({ libraryId: '12345', guid: '9b8c7d6e-1111-2222-3333-444455556666' });
  });
  it('detecta la URL /play/', () => {
    expect(
      parseBunny('https://iframe.mediadelivery.net/play/777/abcdef01-aaaa-bbbb-cccc-ddddeeeeffff'),
    ).toEqual({ libraryId: '777', guid: 'abcdef01-aaaa-bbbb-cccc-ddddeeeeffff' });
  });
  it('null para YouTube o ficheros directos', () => {
    expect(parseBunny('https://youtu.be/abc123')).toBeNull();
    expect(parseBunny('https://cdn.example.com/video.mp4')).toBeNull();
    expect(parseBunny('')).toBeNull();
  });
});

describe('bunnyEmbedUrl', () => {
  const ref = { libraryId: '12345', guid: 'abc-guid' };
  it('construye la URL de embed sin timestamp', () => {
    expect(bunnyEmbedUrl(ref)).toBe(
      'https://iframe.mediadelivery.net/embed/12345/abc-guid?autoplay=false&preload=true&responsive=true',
    );
  });
  it('incluye t= y autoplay al saltar a un capítulo', () => {
    expect(bunnyEmbedUrl(ref, { startSeconds: 135, autoplay: true })).toBe(
      'https://iframe.mediadelivery.net/embed/12345/abc-guid?autoplay=true&preload=true&responsive=true&t=135',
    );
  });
});

describe('parseTimestampToSeconds', () => {
  it('parsea MM:SS', () => {
    expect(parseTimestampToSeconds('02:15')).toBe(135);
    expect(parseTimestampToSeconds('00:00')).toBe(0);
  });
  it('parsea HH:MM:SS', () => {
    expect(parseTimestampToSeconds('1:02:03')).toBe(3723);
  });
  it('null para formatos inválidos', () => {
    expect(parseTimestampToSeconds('2:99')).toBeNull(); // segundos fuera de rango
    expect(parseTimestampToSeconds('abc')).toBeNull();
    expect(parseTimestampToSeconds('12')).toBeNull();
  });
});

describe('formatSeconds', () => {
  it('formatea M:SS', () => {
    expect(formatSeconds(135)).toBe('2:15');
    expect(formatSeconds(0)).toBe('0:00');
  });
  it('formatea H:MM:SS cuando supera la hora', () => {
    expect(formatSeconds(3723)).toBe('1:02:03');
  });
});

describe('parseResources', () => {
  it('convierte líneas MM:SS - Texto en capítulos', () => {
    const lines = parseResources('00:00 - Introducción\n02:15 - Instalar n8n');
    expect(lines).toEqual([
      { kind: 'chapter', seconds: 0, label: 'Introducción' },
      { kind: 'chapter', seconds: 135, label: 'Instalar n8n' },
    ]);
  });
  it('convierte líneas con URL en viñetas con enlace', () => {
    const lines = parseResources('Grupo de Telegram: https://t.me/abc');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'text' });
    if (lines[0]?.kind === 'text') {
      expect(lines[0].segments).toEqual([
        { type: 'text', value: 'Grupo de Telegram: ' },
        { type: 'link', href: 'https://t.me/abc', label: 'https://t.me/abc' },
      ]);
    }
  });
  it('ignora líneas vacías y limpia viñetas previas', () => {
    const lines = parseResources('\n- Recurso suelto\n\n');
    expect(lines).toEqual([
      { kind: 'text', segments: [{ type: 'text', value: 'Recurso suelto' }] },
    ]);
  });
  it('mezcla capítulos y recursos', () => {
    const lines = parseResources('01:00 - Demo\nDocs: https://docs.example.com');
    expect(lines.map((l) => l.kind)).toEqual(['chapter', 'text']);
  });
});

describe('advanceWatch', () => {
  it('suma los avances naturales de reproducción', () => {
    let s = initWatchState();
    // Simula timeupdates espaciados ~1s reproduciendo de 0 a 3s.
    for (const t of [0, 1, 2, 3]) s = advanceWatch(s, t);
    expect(s.watchedSeconds).toBe(3);
    expect(s.maxPositionSeconds).toBe(3);
    expect(s.lastSeconds).toBe(3);
  });

  it('el primer evento no suma (no hay posición previa)', () => {
    const s = advanceWatch(initWatchState(), 10);
    expect(s.watchedSeconds).toBe(0);
    expect(s.maxPositionSeconds).toBe(10);
  });

  it('ignora los saltos hacia delante (seek), pero actualiza la posición máxima', () => {
    let s = initWatchState();
    s = advanceWatch(s, 0);
    s = advanceWatch(s, 1); // +1 visto
    s = advanceWatch(s, 120); // seek a 2:00 → no cuenta como visto
    expect(s.watchedSeconds).toBe(1);
    expect(s.maxPositionSeconds).toBe(120);
  });

  it('ignora los retrocesos (rewind)', () => {
    let s = initWatchState();
    s = advanceWatch(s, 50);
    s = advanceWatch(s, 51); // +1
    s = advanceWatch(s, 10); // rewind → no resta ni suma
    expect(s.watchedSeconds).toBe(1);
    expect(s.maxPositionSeconds).toBe(51);
  });

  it('respeta maxStepSeconds configurable', () => {
    let s = initWatchState();
    s = advanceWatch(s, 0, { maxStepSeconds: 5 });
    s = advanceWatch(s, 4, { maxStepSeconds: 5 }); // delta 4 ≤ 5 → cuenta
    expect(s.watchedSeconds).toBe(4);
  });
});

describe('breakWatchContinuity', () => {
  it('evita contar el salto tras una pausa/seek', () => {
    let s = initWatchState();
    s = advanceWatch(s, 10);
    s = advanceWatch(s, 11); // +1
    s = breakWatchContinuity(s); // el alumno pausa y salta
    s = advanceWatch(s, 200); // primer evento tras el corte → no suma
    expect(s.watchedSeconds).toBe(1);
    expect(s.maxPositionSeconds).toBe(200);
    s = advanceWatch(s, 201); // reanuda → +1
    expect(s.watchedSeconds).toBe(2);
  });
});

describe('watchedPercent', () => {
  it('calcula el porcentaje de cobertura redondeado', () => {
    expect(watchedPercent(90, 100)).toBe(90);
    expect(watchedPercent(33, 100)).toBe(33);
  });
  it('acota a 100 aunque se repita contenido', () => {
    expect(watchedPercent(150, 100)).toBe(100);
  });
  it('devuelve 0 si la duración no es válida', () => {
    expect(watchedPercent(50, 0)).toBe(0);
    expect(watchedPercent(50, -1)).toBe(0);
  });
});
