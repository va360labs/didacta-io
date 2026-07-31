import { describe, expect, it } from 'vitest';
import { buildBodyWithAttachments, parseBodyAttachments } from './attachments';

describe('parseBodyAttachments', () => {
  it('devuelve el body intacto cuando no hay marcador', () => {
    const r = parseBodyAttachments('Hola comunidad');
    expect(r).toEqual({ cleanBody: 'Hola comunidad', images: [], files: [] });
  });

  it('separa el texto del marcador de adjuntos (no lo filtra en crudo)', () => {
    const body =
      'sdfd\n\n<!--didacta-attachments:{"images":[{"url":"https://x/a.png","name":"a.png"}],"files":[]}-->';
    const r = parseBodyAttachments(body);
    expect(r.cleanBody).toBe('sdfd');
    expect(r.cleanBody).not.toContain('didacta-attachments');
    expect(r.images).toEqual([{ url: 'https://x/a.png', name: 'a.png' }]);
    expect(r.files).toEqual([]);
  });

  it('parsea imágenes y archivos juntos', () => {
    const body = buildBodyWithAttachments(
      'texto',
      [{ url: 'https://x/i.png', name: 'i.png' }],
      [{ url: 'https://x/d.pdf', name: 'd.pdf', size: 1024 }],
    );
    const r = parseBodyAttachments(body);
    expect(r.cleanBody).toBe('texto');
    expect(r.images).toHaveLength(1);
    expect(r.files).toEqual([{ url: 'https://x/d.pdf', name: 'd.pdf', size: 1024 }]);
  });

  it('cae al body crudo si el JSON del marcador es inválido', () => {
    const body = 'texto<!--didacta-attachments:{no es json-->';
    const r = parseBodyAttachments(body);
    expect(r.cleanBody).toBe(body);
    expect(r.images).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it('cae al body crudo si el marcador no se cierra', () => {
    const body = 'texto<!--didacta-attachments:{"images":[]}';
    const r = parseBodyAttachments(body);
    expect(r.cleanBody).toBe(body);
  });
});

describe('buildBodyWithAttachments', () => {
  it('devuelve solo el texto recortado cuando no hay adjuntos', () => {
    expect(buildBodyWithAttachments('  hola  ', [], [])).toBe('hola');
  });

  it('es la contraparte exacta de parseBodyAttachments (round-trip)', () => {
    const images = [{ url: 'https://x/a.png', name: 'a.png' }];
    const files = [{ url: 'https://x/b.pdf', name: 'b.pdf', size: 42 }];
    const built = buildBodyWithAttachments('cuerpo', images, files);
    const parsed = parseBodyAttachments(built);
    expect(parsed.cleanBody).toBe('cuerpo');
    expect(parsed.images).toEqual(images);
    expect(parsed.files).toEqual(files);
  });
});
