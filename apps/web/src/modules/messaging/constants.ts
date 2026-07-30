/** Constantes compartidas de la mensajería en el cliente. */

/** Espejo de `MESSAGE_MAX_LENGTH` del dominio (modules/messaging). */
export const MESSAGE_MAX_LENGTH = 4000;

/**
 * Mínimo entre dos avisos de «está escribiendo» (ADR-019). El cupo del servidor
 * es de 30/min: a 3 s el cliente se queda holgadamente por debajo aunque tenga
 * varias conversaciones abiertas.
 */
export const TYPING_THROTTLE_MS = 3_000;

/** Clave de persistencia del panel abierto. */
export const FLOATING_CHAT_OPEN_KEY = 'didacta:chat-flotante:open';
