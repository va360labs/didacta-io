import { describe, expect, it } from 'vitest';
import {
  bunnyEmbedUrl,
  formatSeconds,
  parseBunny,
  parseResources,
  parseTimestampToSeconds,
  parseYouTubeId,
  parseYouTubeStartSeconds,
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
