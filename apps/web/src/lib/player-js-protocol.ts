/**
 * Implementación mínima del protocolo Player.js (postMessage), que es el que
 * expone el reproductor de Bunny Stream en su iframe.
 *
 * Por qué inline y no la dependencia `player.js`: el paquete está congelado
 * desde 2017 y, sobre todo, añadir una dependencia obliga a reinstalar
 * `node_modules` en el servidor de dev (el flujo rápido `dev:push` solo
 * sincroniza `src/`). Replicamos solo lo que necesitamos —suscribirnos a
 * eventos y parsear los que emite el iframe— en código puro y testeable.
 *
 * Spec: https://github.com/embedly/player.js
 */

export const PLAYERJS_CONTEXT = 'player.js';
const PLAYERJS_VERSION = '0.0.11';

export type PlayerEventName = 'ready' | 'play' | 'pause' | 'ended' | 'timeupdate' | 'error';

export interface PlayerTimeUpdate {
  /** Posición actual de reproducción, en segundos. */
  seconds: number;
  /** Duración total del vídeo, en segundos (0 si el player no la conoce aún). */
  duration: number;
}

export interface PlayerCommand {
  context: typeof PLAYERJS_CONTEXT;
  version: string;
  method: 'addEventListener' | 'removeEventListener';
  value: PlayerEventName;
  listener?: string;
}

/** Construye un comando `addEventListener` para suscribirse a un evento. */
export function buildAddEventListener(event: PlayerEventName, listener?: string): PlayerCommand {
  return {
    context: PLAYERJS_CONTEXT,
    version: PLAYERJS_VERSION,
    method: 'addEventListener',
    value: event,
    ...(listener ? { listener } : {}),
  };
}

export interface ParsedPlayerEvent {
  event: string;
  value: unknown;
}

/**
 * Parsea un mensaje recibido del iframe. Devuelve `{ event, value }` si es un
 * mensaje Player.js válido (acepta string JSON u objeto ya parseado), o null en
 * cualquier otro caso (mensaje de otra librería, JSON inválido, sin evento).
 */
export function parsePlayerMessage(raw: unknown): ParsedPlayerEvent | null {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (obj['context'] !== PLAYERJS_CONTEXT) return null;
  if (typeof obj['event'] !== 'string') return null;
  return { event: obj['event'], value: obj['value'] };
}

/**
 * Extrae `{ seconds, duration }` de un value de `timeupdate`, validando tipos.
 * `seconds` debe ser un número finito; `duration` cae a 0 si no es válida.
 */
export function asTimeUpdate(value: unknown): PlayerTimeUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const seconds = v['seconds'];
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const duration = v['duration'];
  return {
    seconds,
    duration: typeof duration === 'number' && Number.isFinite(duration) ? duration : 0,
  };
}
