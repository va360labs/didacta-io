import { describe, expect, it } from 'vitest';
import { parseYouTubeId, parseYouTubeStartSeconds, youTubeEmbedUrl } from './video';

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
