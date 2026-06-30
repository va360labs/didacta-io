import { describe, expect, it } from 'vitest';
import { tokenizeRichText } from './rich-body';

describe('tokenizeRichText', () => {
  it('autolinka una URL suelta', () => {
    expect(tokenizeRichText('mira https://didacta.io aquí')).toEqual([
      { type: 'text', value: 'mira ' },
      { type: 'link', href: 'https://didacta.io', label: 'https://didacta.io' },
      { type: 'text', value: ' aquí' },
    ]);
  });

  it('no arrastra la puntuación final dentro del href', () => {
    expect(tokenizeRichText('web (https://didacta.io).')).toEqual([
      { type: 'text', value: 'web (' },
      { type: 'link', href: 'https://didacta.io', label: 'https://didacta.io' },
      { type: 'text', value: ').' },
    ]);
  });

  it('parsea un enlace markdown [texto](url)', () => {
    expect(tokenizeRichText('ver [la guía](https://didacta.io/guia) ahora')).toEqual([
      { type: 'text', value: 'ver ' },
      { type: 'link', href: 'https://didacta.io/guia', label: 'la guía' },
      { type: 'text', value: ' ahora' },
    ]);
  });

  it('resalta menciones @handle', () => {
    expect(tokenizeRichText('hola @valen ¿cómo vas?')).toEqual([
      { type: 'text', value: 'hola ' },
      { type: 'mention', handle: 'valen' },
      { type: 'text', value: ' ¿cómo vas?' },
    ]);
  });

  it('combina texto, mención, salto de línea y URL', () => {
    expect(tokenizeRichText('@ana\nlee https://x.com')).toEqual([
      { type: 'mention', handle: 'ana' },
      { type: 'text', value: '\nlee ' },
      { type: 'link', href: 'https://x.com', label: 'https://x.com' },
    ]);
  });

  it('texto plano → un único nodo de texto', () => {
    expect(tokenizeRichText('sin nada especial')).toEqual([
      { type: 'text', value: 'sin nada especial' },
    ]);
  });

  it('una URL dentro de un markdown link no se duplica', () => {
    expect(tokenizeRichText('[doc](https://a.com/b)')).toEqual([
      { type: 'link', href: 'https://a.com/b', label: 'doc' },
    ]);
  });
});
