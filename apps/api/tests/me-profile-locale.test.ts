import { describe, expect, it } from 'vitest';
import { ALLOWED_LOCALES, updateProfileSchema } from '../src/auth/me.controller';

/**
 * Contrato de idioma de `PATCH /api/v1/me/profile`.
 *
 * `pt-BR` estuvo en `ALLOWED_LOCALES` sin tener catálogo de mensajes en la web.
 * La consecuencia no era cosmética: el endpoint PERSISTÍA el valor, así que un
 * usuario acababa con un perfil en un idioma que la interfaz no sabe pintar y
 * `/cuenta` se lo confirmaba («Português (Brasil)») mientras la UI seguía en
 * español. Quitarlo del selector sin quitarlo de aquí habría dejado la API
 * guardando lo mismo por SCIM, por curl o por un cliente viejo.
 */
describe('PATCH /me/profile · locale', () => {
  it('rechaza pt-BR: el producto no lo tiene traducido', () => {
    const parsed = updateProfileSchema.safeParse({ locale: 'pt-BR' });
    expect(parsed.success).toBe(false);
  });

  it('acepta los idiomas que la UI sabe pintar', () => {
    for (const locale of ['es-ES', 'es-AR', 'en-US', 'id-ID']) {
      expect(updateProfileSchema.safeParse({ locale }).success, locale).toBe(true);
    }
  });

  it('la lista permitida es exactamente esa (guarda contra reintroducirlo)', () => {
    expect([...ALLOWED_LOCALES]).toEqual(['es-ES', 'es-AR', 'en-US', 'id-ID']);
  });

  it('sigue rechazando cualquier otro tag', () => {
    for (const locale of ['fr-FR', 'es', 'en', 'zz', '']) {
      expect(updateProfileSchema.safeParse({ locale }).success, locale).toBe(false);
    }
  });

  it('omitir el locale sigue siendo válido (no toca el guardado)', () => {
    // Es lo que protege a quien ya tiene `pt-BR`: puede editar su nombre sin
    // que la API le exija cambiar de idioma primero.
    expect(updateProfileSchema.safeParse({ name: 'Ana' }).success).toBe(true);
  });
});
