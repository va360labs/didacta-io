import { describe, expect, it } from 'vitest';
import { ALLOWED_LOCALES, updateProfileSchema } from '../src/auth/me.controller';

/**
 * Contrato de idioma de `PATCH /api/v1/me/profile`.
 *
 * `pt-BR` estuvo en `ALLOWED_LOCALES` sin tener catálogo de mensajes en la web.
 * La consecuencia no era cosmética: el endpoint PERSISTÍA el valor, así que un
 * usuario acababa con un perfil en un idioma que la interfaz no sabe pintar y
 * `/account` se lo confirmaba («Português (Brasil)») mientras la UI seguía en
 * español. Se retiró de aquí y del selector a la vez.
 *
 * Vuelve ahora que el producto lo tiene traducido de verdad (catálogo `pt` en
 * la web y en los correos). La regla que estos tests conservan es la de fondo:
 * esta lista no acepta nada que la web no sepa pintar.
 */
describe('PATCH /me/profile · locale', () => {
  it('acepta pt-BR: el producto ya lo tiene traducido', () => {
    const parsed = updateProfileSchema.safeParse({ locale: 'pt-BR' });
    expect(parsed.success).toBe(true);
  });

  it('acepta los cuatro idiomas que la UI sabe pintar', () => {
    for (const locale of ['es-ES', 'es-AR', 'en-US', 'pt-BR']) {
      expect(updateProfileSchema.safeParse({ locale }).success, locale).toBe(true);
    }
  });

  it('la lista permitida es exactamente esa (guarda contra añadir un idioma sin catálogo)', () => {
    // Añadir un tag aquí exige ANTES su catálogo en apps/web/src/i18n/messages
    // y en HUB_TEMPLATE_LANGS; si no, se repite el bug de arriba.
    expect([...ALLOWED_LOCALES]).toEqual(['es-ES', 'es-AR', 'en-US', 'pt-BR']);
  });

  it('sigue rechazando cualquier otro tag (control: portugués europeo e idioma sin región)', () => {
    for (const locale of ['pt-PT', 'pt', 'fr-FR', 'es', 'en', 'zz', '']) {
      expect(updateProfileSchema.safeParse({ locale }).success, locale).toBe(false);
    }
  });

  it('omitir el locale sigue siendo válido (no toca el guardado)', () => {
    // Es lo que protege a quien tiene guardado un tag que la lista no admite
    // (por SCIM): puede editar su nombre sin que la API le exija cambiar de
    // idioma primero.
    expect(updateProfileSchema.safeParse({ name: 'Ana' }).success).toBe(true);
  });
});
