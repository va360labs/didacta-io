import { describe, expect, it } from 'vitest';
import { buildClaseAnnouncementBody, parseClaseEmbed } from './clase-embed';

const ID = 'ad532bd7-ffb7-40b7-b3b1-a2d57b3108cd';

describe('parseClaseEmbed — marcador', () => {
  it('extrae la sesión y deja el texto limpio', () => {
    const body = buildClaseAnnouncementBody('Nueva clase en directo el lunes.', ID);
    const parsed = parseClaseEmbed(body);
    expect(parsed.sessionId).toBe(ID);
    expect(parsed.cleanBody).toBe('Nueva clase en directo el lunes.');
    expect(parsed.cleanBody).not.toContain('didacta-clase');
  });

  it('normaliza el uuid a minúsculas', () => {
    const parsed = parseClaseEmbed(`Hola\n\n<!--didacta-clase:${ID.toUpperCase()}-->`);
    expect(parsed.sessionId).toBe(ID);
  });

  it('el marcador gana sobre un enlace suelto', () => {
    const otro = '11111111-2222-3333-4444-555555555555';
    const parsed = parseClaseEmbed(`Mira /clase/${otro}\n\n<!--didacta-clase:${ID}-->`);
    expect(parsed.sessionId).toBe(ID);
  });
});

describe('parseClaseEmbed — enlace pegado a mano', () => {
  it('reconoce una URL absoluta y la quita del texto', () => {
    const parsed = parseClaseEmbed(`Os dejo la clase: https://aula.va360.academy/clase/${ID}`);
    expect(parsed.sessionId).toBe(ID);
    expect(parsed.cleanBody).toBe('Os dejo la clase:');
  });

  it('reconoce una ruta relativa', () => {
    const parsed = parseClaseEmbed(`Apuntaos en /clase/${ID}/ antes del lunes`);
    expect(parsed.sessionId).toBe(ID);
    expect(parsed.cleanBody).toBe('Apuntaos en antes del lunes');
  });

  it('no colapsa el texto en párrafos cuando el enlace iba solo en su línea', () => {
    const parsed = parseClaseEmbed(`Primera\n\nhttps://aula.va360.academy/clase/${ID}\n\nÚltima`);
    expect(parsed.cleanBody).toBe('Primera\n\nÚltima');
  });
});

describe('parseClaseEmbed — sin clase', () => {
  it('devuelve el body intacto', () => {
    const body = 'Un post normal con un enlace https://va360.academy/cursos';
    expect(parseClaseEmbed(body)).toEqual({ cleanBody: body, sessionId: null });
  });

  it('ignora un /clase/ que no lleva uuid', () => {
    expect(parseClaseEmbed('mira /clase/12345').sessionId).toBeNull();
  });
});
