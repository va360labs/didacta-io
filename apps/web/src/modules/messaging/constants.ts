/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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

/** Vida de un aviso de mensaje nuevo con el chat plegado (ms). */
export const CHAT_TOAST_MS = 7_000;

/**
 * Avisos simultáneos como máximo. Con más, una sala activa convierte la esquina
 * en una cascada y deja de leerse nada.
 */
export const CHAT_TOAST_MAX = 2;
