import { describe, expect, it } from 'vitest';
import { parseRichBlocks, tokenizeRichText } from './rich-body';

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
    expect(tokenizeRichText('hola @ana ¿cómo vas?')).toEqual([
      { type: 'text', value: 'hola ' },
      { type: 'mention', handle: 'ana' },
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

  it('parsea **negrita** con texto alrededor', () => {
    expect(tokenizeRichText('esto es **importante** de verdad')).toEqual([
      { type: 'text', value: 'esto es ' },
      { type: 'bold', children: [{ type: 'text', value: 'importante' }] },
      { type: 'text', value: ' de verdad' },
    ]);
  });

  it('una negrita puede contener un enlace markdown', () => {
    expect(tokenizeRichText('**mira [esto](https://a.com)**')).toEqual([
      {
        type: 'bold',
        children: [
          { type: 'text', value: 'mira ' },
          { type: 'link', href: 'https://a.com', label: 'esto' },
        ],
      },
    ]);
  });

  it('parsea *cursiva* pero no multiplicaciones "5 * 3 * 2"', () => {
    expect(tokenizeRichText('un *matiz* sutil')).toEqual([
      { type: 'text', value: 'un ' },
      { type: 'italic', children: [{ type: 'text', value: 'matiz' }] },
      { type: 'text', value: ' sutil' },
    ]);
    expect(tokenizeRichText('5 * 3 * 2')).toEqual([{ type: 'text', value: '5 * 3 * 2' }]);
  });

  it('parsea `código` inline y no interpreta markdown dentro', () => {
    expect(tokenizeRichText('usa `pnpm **build**` ya')).toEqual([
      { type: 'text', value: 'usa ' },
      { type: 'code', value: 'pnpm **build**' },
      { type: 'text', value: ' ya' },
    ]);
  });
});

describe('parseRichBlocks', () => {
  it('separa títulos, listas y párrafos (formato del digest semanal)', () => {
    const body = [
      '¡Buenas familia!',
      '',
      '## 🍳 Inteligencia Artificial',
      '',
      '- **OpenAI frito:** la caída global ([ver mensaje](https://t.me/c/1/2))',
      '- **Claude Opus 5:** el hype encendió el grupo',
      '',
      '¡A darle caña!',
    ].join('\n');
    const blocks = parseRichBlocks(body);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'list', 'paragraph']);

    const heading = blocks[1] as Extract<(typeof blocks)[number], { type: 'heading' }>;
    expect(heading.level).toBe(2);
    expect(heading.children).toEqual([{ type: 'text', value: '🍳 Inteligencia Artificial' }]);

    const list = blocks[2] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toEqual([
      { type: 'bold', children: [{ type: 'text', value: 'OpenAI frito:' }] },
      { type: 'text', value: ' la caída global (' },
      { type: 'link', href: 'https://t.me/c/1/2', label: 'ver mensaje' },
      { type: 'text', value: ')' },
    ]);
  });

  it('un salto simple es <br> dentro del párrafo; el doble separa párrafos', () => {
    const blocks = parseRichBlocks('línea 1\nlínea 2\n\notro párrafo');
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        lines: [[{ type: 'text', value: 'línea 1' }], [{ type: 'text', value: 'línea 2' }]],
      },
      { type: 'paragraph', lines: [[{ type: 'text', value: 'otro párrafo' }]] },
    ]);
  });

  it('lista numerada con `1.` y `2)`', () => {
    const blocks = parseRichBlocks('1. primero\n2) segundo');
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: true,
        items: [[{ type: 'text', value: 'primero' }], [{ type: 'text', value: 'segundo' }]],
      },
    ]);
  });

  it('#hashtag (sin espacio) NO es título y "* " sí es viñeta', () => {
    const blocks = parseRichBlocks('#novedades\n* item estrella');
    expect(blocks).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', value: '#novedades' }]] },
      { type: 'list', ordered: false, items: [[{ type: 'text', value: 'item estrella' }]] },
    ]);
  });

  it('texto plano multilínea queda como un único párrafo', () => {
    expect(parseRichBlocks('sin nada especial')).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', value: 'sin nada especial' }]] },
    ]);
  });
});
