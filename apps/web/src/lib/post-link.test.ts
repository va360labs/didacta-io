import { describe, expect, it } from 'vitest';
import { parsePostPath, postPath } from './post-link';

describe('postPath', () => {
  it('construye la URL canónica del post', () => {
    expect(postPath('abc-123')).toBe('/comunidad/abc-123');
  });

  it('añade ?comment= cuando se enfoca un comentario', () => {
    expect(postPath('abc-123', { commentId: 'c-9' })).toBe('/comunidad/abc-123?comment=c-9');
  });

  it('escapa ids con caracteres raros', () => {
    expect(postPath('a/b')).toBe('/comunidad/a%2Fb');
  });
});

describe('parsePostPath', () => {
  it('extrae el id de la URL canónica', () => {
    expect(parsePostPath('/comunidad/abc-123')).toBe('abc-123');
  });

  it('devuelve null para el feed y rutas hermanas', () => {
    expect(parsePostPath('/comunidad')).toBeNull();
    expect(parsePostPath('/comunidad/')).toBeNull();
    expect(parsePostPath('/comunidad/menciones')).toBeNull();
    expect(parsePostPath('/espacios/general')).toBeNull();
  });

  it('es inverso de postPath incluso con ids escapados', () => {
    expect(parsePostPath(postPath('a/b'))).toBe('a/b');
  });
});
