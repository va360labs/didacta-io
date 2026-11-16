/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { brandPrimaryHex } from '../modules/payouts/payouts-branding.sync';

/**
 * Color de marca del aula ↔ `#RRGGBB`, para `GET/PUT /admin/tenants/:id/branding`.
 *
 * El aula NO guarda un hex: guarda tono y saturación (`mod.theming`,
 * `brandHue` 0–360 y `brandSaturation` 0–100) y la luminosidad es fija (38 %).
 * El color que pinta la web es `brandPrimaryHex(hue, saturation)`
 * (`payouts-branding.sync.ts`: saturación + 2, luminosidad 38 %), y es lo que
 * lee Stripe. Por eso:
 *
 *  - Al LEER, el hex es siempre el del aula tal como se pinta.
 *  - Al ESCRIBIR, se toman el tono y la saturación del hex recibido y se
 *    descarta su luminosidad: `#FFCC00` (luminosidad 50 %) queda como el
 *    mismo tono y saturación a 38 %. Quien llama debe leer de vuelta el hex
 *    normalizado; la respuesta del PUT ya lo trae.
 */

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** `#RRGGBB` → tono (0–359) y saturación (0–100) del color de marca. */
export function hexToBrand(hex: string): { brandHue: number; brandSaturation: number } {
  if (!HEX_COLOR.test(hex)) throw new Error(`Color no válido: ${hex}`);
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return {
    brandHue: Math.round(hue) % 360,
    // `brandPrimaryHex` suma 2 a la saturación guardada: se deshace aquí.
    brandSaturation: Math.min(100, Math.max(0, Math.round(saturation * 100) - 2)),
  };
}

/** El color de marca de un aula (`#rrggbb`, minúsculas) tal como se pinta. */
export function brandToHex(hue: number, saturation: number): string {
  return brandPrimaryHex(hue, saturation);
}
