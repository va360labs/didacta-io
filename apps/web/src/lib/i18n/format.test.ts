import { afterEach, describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import es from '@/i18n/messages/es';
import en from '@/i18n/messages/en';
import {
  formatCents,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTime,
} from './format';
import { resetUserFormatPrefs, setUserFormatPrefs } from './user-prefs';

const D = new Date('2026-08-07T15:30:00.000Z');

afterEach(() => {
  resetUserFormatPrefs();
});

describe('formatDate / formatDateTime / formatTime', () => {
  it('con overrides explícitos es determinista (patrón RSC)', () => {
    expect(formatDate(D, { locale: 'en-US', timeZone: 'UTC', dateStyle: 'medium' })).toBe(
      'Aug 7, 2026',
    );
    expect(formatDate(D, { locale: 'es-ES', timeZone: 'UTC', day: 'numeric', month: 'long' })).toBe(
      '7 de agosto',
    );
  });

  it('acepta string ISO y epoch además de Date', () => {
    expect(formatDate('2026-08-07T15:30:00.000Z', { locale: 'en-US', timeZone: 'UTC' })).toBe(
      formatDate(D, { locale: 'en-US', timeZone: 'UTC' }),
    );
    expect(formatDate(D.getTime(), { locale: 'en-US', timeZone: 'UTC' })).toBe(
      formatDate(D, { locale: 'en-US', timeZone: 'UTC' }),
    );
  });

  it('usa el singleton de prefs cuando no hay override (patrón client)', () => {
    setUserFormatPrefs({ locale: 'en-US', timeZone: 'America/New_York' });
    expect(formatTime(D, { hour: '2-digit', minute: '2-digit', hour12: false })).toBe('11:30');
    setUserFormatPrefs({ timeZone: 'Europe/Madrid' });
    expect(formatTime(D, { hour: '2-digit', minute: '2-digit', hour12: false })).toBe('17:30');
  });

  it('la timezone del usuario afecta a la FECHA mostrada (bug que motivó F1)', () => {
    const nearMidnight = new Date('2026-08-07T23:30:00.000Z');
    const madrid = formatDateTime(nearMidnight, {
      locale: 'es-ES',
      timeZone: 'Europe/Madrid',
      day: 'numeric',
    });
    const buenosAires = formatDateTime(nearMidnight, {
      locale: 'es-ES',
      timeZone: 'America/Argentina/Buenos_Aires',
      day: 'numeric',
    });
    expect(madrid).not.toBe(buenosAires);
  });
});

describe('formatNumber / formatCurrency', () => {
  it('separadores por locale (es-ES vs en-US)', () => {
    expect(formatNumber(1234.5, { locale: 'es-ES' })).toBe('1234,5');
    expect(formatNumber(1234.5, { locale: 'en-US' })).toBe('1,234.5');
  });

  it('moneda EUR por defecto, otras monedas configurables', () => {
    expect(formatCurrency(1234.5, 'EUR', { locale: 'es-ES' })).toContain('€');
    expect(formatCurrency(99, 'USD', { locale: 'en-US' })).toBe('$99.00');
  });
});

describe('formatCents', () => {
  it('cantidad redonda → sin decimales; con resto → 2 decimales', () => {
    expect(formatCents(99900, 'USD', { locale: 'en-US' })).toBe('$999');
    expect(formatCents(99950, 'USD', { locale: 'en-US' })).toBe('$999.50');
  });

  it('respeta overrides explícitos de decimales', () => {
    expect(formatCents(99900, 'USD', { locale: 'en-US', minimumFractionDigits: 2 })).toBe(
      '$999.00',
    );
  });
});

describe('formatDuration (ICU, sucesora de lib/format)', () => {
  const tEs = createTranslator({ locale: 'es-ES', messages: es, namespace: 'common' });
  const tEn = createTranslator({ locale: 'en-US', messages: en, namespace: 'common' });

  it('mantiene el contrato de la vieja formatDuration (paridad lib/format.test)', () => {
    expect(formatDuration(45, tEs)).toBe('45 min');
    expect(formatDuration(60, tEs)).toBe('1 h');
    expect(formatDuration(90, tEs)).toBe('1 h 30 min');
    expect(formatDuration(3000, tEs)).toBe('50 h');
    expect(formatDuration(0, tEs)).toBe('0 min');
  });

  it('null/undefined/negativo/no-finito → null', () => {
    expect(formatDuration(null, tEs)).toBeNull();
    expect(formatDuration(undefined, tEs)).toBeNull();
    expect(formatDuration(-5, tEs)).toBeNull();
    expect(formatDuration(Number.NaN, tEs)).toBeNull();
  });

  it('resuelve contra el catálogo del locale activo', () => {
    expect(formatDuration(90, tEn)).toBe('1 h 30 min');
  });
});
