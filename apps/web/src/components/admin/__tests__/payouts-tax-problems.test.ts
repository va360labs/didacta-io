/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * «Tus datos fiscales»: cuando la API rechaza el guardado, el aviso dice QUÉ
 * campo y por qué («El NIF no es válido. Revisa el formato.»), no el genérico
 * «faltan campos o no son válidos» que vio la creadora en el ensayo general.
 */

import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import { taxProblemsMessage } from '@/components/admin/payouts-tax-profile-card';
import type { TranslatorLike } from '@/lib/i18n/labels';
import { taxProfileFieldErrors } from '@/lib/payouts';

const tr = (locale: 'es-ES' | 'en-US' | 'pt-BR', messages: typeof es) =>
  createTranslator({ locale, messages, namespace: 'adminPagos.payouts.tax' });
const tEs = tr('es-ES', es);
const tEn = tr('en-US', en as unknown as typeof es);
const tPt = tr('pt-BR', pt as unknown as typeof es);

describe('error concreto al guardar los datos fiscales', () => {
  it('ensayo general (pt-BR): NIF con mal formato → «O NIF não é válido. Confira o formato.»', () => {
    const fields = taxProfileFieldErrors('taxId:format');
    expect(taxProblemsMessage(fields, tPt)).toBe('O NIF não é válido. Confira o formato.');
    expect(taxProblemsMessage(fields, tEs)).toBe('El NIF no es válido. Revisa el formato.');
    expect(taxProblemsMessage(fields, tEn)).toBe("The tax ID isn't valid. Check the format.");
  });

  it('letra de control que no cuadra y fecha que falta, en el orden del formulario', () => {
    const fields = taxProfileFieldErrors('birthDate:required,taxId:check_digit');
    expect(taxProblemsMessage(fields, tEs)).toBe(
      'El NIF no es válido. La letra o el dígito de control no cuadra. Falta la fecha de nacimiento.',
    );
  });

  it('dirección (campos con punto en la API) y NIF-IVA de fuera de la UE', () => {
    const fields = taxProfileFieldErrors('address.postalCode:required,vatId:not_eu');
    expect(taxProblemsMessage(fields, tEs)).toBe(
      'El NIF-IVA no es válido. Solo para países de la UE. Falta el código postal.',
    );
  });

  it('sin campos conocidos, `null`: se queda el mensaje de la API', () => {
    expect(taxProblemsMessage({}, tEs)).toBeNull();
    expect(taxProblemsMessage(taxProfileFieldErrors('otro:raro'), tEs)).toBeNull();
  });

  it('las frases existen en los tres idiomas para cada campo', () => {
    const fields = [
      'entityType',
      'legalName',
      'country',
      'taxId',
      'vatId',
      'addressLine1',
      'addressPostalCode',
      'addressCity',
      'birthDate',
    ];
    for (const t of [tEs, tEn, tPt] as unknown as TranslatorLike[]) {
      for (const field of fields) {
        expect(t.has(`problems.${field}.required`), field).toBe(true);
        expect(t.has(`problems.${field}.invalid`), field).toBe(true);
      }
    }
  });
});
