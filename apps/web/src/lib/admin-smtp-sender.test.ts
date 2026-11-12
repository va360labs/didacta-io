import { describe, expect, it } from 'vitest';
import { isValidReplyToInput, normalizeReplyToInput } from './admin-smtp';

describe('«Correo para respuestas» — entrada del formulario', () => {
  it('vacío o solo espacios = quitarlo (null) y es válido', () => {
    expect(normalizeReplyToInput('')).toBeNull();
    expect(normalizeReplyToInput('   ')).toBeNull();
    expect(isValidReplyToInput('  ')).toBe(true);
  });

  it('recorta espacios y acepta una dirección', () => {
    expect(normalizeReplyToInput(' contacto@academia.es ')).toBe('contacto@academia.es');
    expect(isValidReplyToInput(' contacto@academia.es ')).toBe(true);
  });

  it.each(['a@b.es, c@d.es', 'a@b.es;c@d.es', 'Yo <a@b.es>', 'a b@c.es', 'sin-arroba.es', 'a@b'])(
    'rechaza «%s»',
    (v) => {
      expect(isValidReplyToInput(v)).toBe(false);
    },
  );
});
