import { describe, expect, it } from 'vitest';
import {
  asTimeUpdate,
  buildAddEventListener,
  parsePlayerMessage,
  PLAYERJS_CONTEXT,
} from './player-js-protocol';

describe('buildAddEventListener', () => {
  it('construye un comando addEventListener con contexto y versión', () => {
    expect(buildAddEventListener('timeupdate')).toEqual({
      context: PLAYERJS_CONTEXT,
      version: '0.0.11',
      method: 'addEventListener',
      value: 'timeupdate',
    });
  });
  it('incluye el listener id cuando se pasa', () => {
    expect(buildAddEventListener('ready', 'abc')).toMatchObject({
      value: 'ready',
      listener: 'abc',
    });
  });
});

describe('parsePlayerMessage', () => {
  it('parsea un mensaje JSON válido de Player.js', () => {
    const raw = JSON.stringify({
      context: PLAYERJS_CONTEXT,
      event: 'timeupdate',
      value: { seconds: 12, duration: 540 },
    });
    expect(parsePlayerMessage(raw)).toEqual({
      event: 'timeupdate',
      value: { seconds: 12, duration: 540 },
    });
  });
  it('acepta un objeto ya parseado', () => {
    expect(parsePlayerMessage({ context: PLAYERJS_CONTEXT, event: 'pause' })).toEqual({
      event: 'pause',
      value: undefined,
    });
  });
  it('null para mensajes de otro contexto', () => {
    expect(parsePlayerMessage({ context: 'vimeo', event: 'play' })).toBeNull();
  });
  it('null para JSON inválido', () => {
    expect(parsePlayerMessage('{no-es-json')).toBeNull();
  });
  it('null para mensajes sin evento', () => {
    expect(parsePlayerMessage({ context: PLAYERJS_CONTEXT })).toBeNull();
  });
  it('null para valores no-objeto', () => {
    expect(parsePlayerMessage(42)).toBeNull();
    expect(parsePlayerMessage(null)).toBeNull();
  });
});

describe('asTimeUpdate', () => {
  it('extrae seconds y duration válidos', () => {
    expect(asTimeUpdate({ seconds: 10.5, duration: 300 })).toEqual({
      seconds: 10.5,
      duration: 300,
    });
  });
  it('cae a duration 0 si falta o no es finita', () => {
    expect(asTimeUpdate({ seconds: 10 })).toEqual({ seconds: 10, duration: 0 });
    expect(asTimeUpdate({ seconds: 10, duration: Infinity })).toEqual({ seconds: 10, duration: 0 });
  });
  it('null si seconds no es un número finito', () => {
    expect(asTimeUpdate({ duration: 100 })).toBeNull();
    expect(asTimeUpdate({ seconds: NaN, duration: 100 })).toBeNull();
    expect(asTimeUpdate('nope')).toBeNull();
    expect(asTimeUpdate(null)).toBeNull();
  });
});
