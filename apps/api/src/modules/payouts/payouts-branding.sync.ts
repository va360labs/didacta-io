/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  publicBusinessUrl,
  type PayoutsBrandImage,
  type PayoutsBrandInput,
} from '@didacta/mod-payouts';
import { Logger as PinoLogger } from 'nestjs-pino';
import sharp from 'sharp';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { ModuleRegistryService } from '../module-registry.service';
import { PayoutsRuntime } from './payouts-runtime.service';

/**
 * Lleva la MARCA DEL AULA (nombre, logo, color y dirección) a su cuenta
 * conectada de Stripe, para que el pago, los recibos y el extracto del banco
 * la enseñen.
 * El dominio (qué se manda y cuándo no hace falta) vive en
 * `PayoutsBrandingService` (`mod.payouts`); aquí se reúne la marca del aula y
 * se prepara la imagen.
 *
 * Cuándo se sincroniza (siempre en segundo plano, nunca bloquea una venta):
 *
 *  - al guardar la marca del aula (logo, color) → `request`;
 *  - al cambiar la dirección del aula (`AcademyAddressService`) → `request`;
 *  - al volver del alta de cobros y en el barrido de las cuentas listas;
 *  - cuando alguien abre la ficha de venta o paga (`ensureFresh`, como mucho
 *    una vez cada 10 minutos por aula): cubre un cambio de nombre o cualquier
 *    otro camino que no avise, antes de que llegue el siguiente comprador.
 *
 * Cada sincronización cuesta una lectura de la cuenta; solo si la huella
 * cambió se suben imágenes y se escribe. Dos peticiones a la vez para la misma
 * aula se juntan en una (y se repite una vez si llegó otra mientras tanto).
 */

/** Cada cuánto, como mucho, se comprueba la marca al abrir la ficha o pagar. */
export const BRANDING_FRESH_MS = 10 * 60_000;
/** Lado del icono cuadrado que se sube a Stripe (mínimo de Stripe: 128). */
const ICON_SIZE = 512;
/** Tope de Stripe para las imágenes de marca. */
const MAX_BYTES = 512 * 1024;

/** `hsl()` → `#rrggbb`. */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/**
 * El color principal del aula tal como lo pinta la web (`--color-brand-600`:
 * tono del aula, su saturación + 2 y luminosidad 38 %).
 */
export function brandPrimaryHex(hue: number, saturation: number): string {
  return hslToHex(((hue % 360) + 360) % 360, saturation + 2, 38);
}

/** El logo del aula en cuadrado, con margen y fondo blanco: el icono de Stripe. */
export async function squareIcon(source: Buffer): Promise<PayoutsBrandImage> {
  const inner = Math.round(ICON_SIZE * 0.8);
  const bytes = await sharp(source, { density: 300 })
    .resize(inner, inner, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .extend({
      top: (ICON_SIZE - inner) / 2,
      bottom: (ICON_SIZE - inner) / 2,
      left: (ICON_SIZE - inner) / 2,
      right: (ICON_SIZE - inner) / 2,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { bytes: new Uint8Array(bytes), contentType: 'image/png' };
}

/** El logo con nombre, al tamaño que admite Stripe (≥128 px, <512 KB). */
export async function wordmarkLogo(source: Buffer): Promise<PayoutsBrandImage> {
  const resized = sharp(source, { density: 300 }).resize({
    width: 1200,
    height: 480,
    fit: 'inside',
    withoutEnlargement: false,
  });
  const meta = await resized.clone().png().toBuffer({ resolveWithObject: true });
  // Stripe exige al menos 128 px por lado: un logo muy apaisado se rellena.
  const padY = Math.max(0, Math.ceil((128 - meta.info.height) / 2));
  const padX = Math.max(0, Math.ceil((128 - meta.info.width) / 2));
  let image = sharp(meta.data);
  if (padX || padY) {
    image = image.extend({
      top: padY,
      bottom: padY,
      left: padX,
      right: padX,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    });
  }
  const png = await image.png({ compressionLevel: 9 }).toBuffer();
  if (png.length <= MAX_BYTES) return { bytes: new Uint8Array(png), contentType: 'image/png' };
  const jpeg = await sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
  return { bytes: new Uint8Array(jpeg), contentType: 'image/jpeg' };
}

@Injectable()
export class PayoutsBrandingSync {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly checkedAt = new Map<string, number>();

  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly logger: PinoLogger,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** La marca cambió (o la cuenta acaba de quedar lista): sincroniza ya. */
  request(tenantId: string): void {
    this.checkedAt.set(tenantId, Date.now());
    void this.run(tenantId);
  }

  /** Comprobación barata al abrir la ficha o pagar: como mucho cada 10 min. */
  ensureFresh(tenantId: string): void {
    const last = this.checkedAt.get(tenantId) ?? 0;
    if (Date.now() - last < BRANDING_FRESH_MS) return;
    this.request(tenantId);
  }

  /** Para tests y el barrido: espera a que termine la sincronización. */
  async syncNow(tenantId: string): Promise<void> {
    this.checkedAt.set(tenantId, Date.now());
    await this.run(tenantId);
  }

  private run(tenantId: string): Promise<void> {
    const current = this.inFlight.get(tenantId);
    if (current) {
      this.again.add(tenantId);
      return current;
    }
    const job = (async () => {
      try {
        do {
          this.again.delete(tenantId);
          const brand = await this.collect(tenantId);
          if (brand) await this.runtime.branding.sync(tenantId, brand);
        } while (this.again.has(tenantId));
      } catch (err) {
        this.logger.warn(
          { tenantId, err: err instanceof Error ? err.message : String(err) },
          'payouts: no se pudo preparar la marca del aula para Stripe',
        );
      } finally {
        this.inFlight.delete(tenantId);
      }
    })();
    this.inFlight.set(tenantId, job);
    return job;
  }

  /** Nombre, color, logo (mod.theming) y dirección del aula, listos para Stripe. */
  private async collect(tenantId: string): Promise<PayoutsBrandInput | null> {
    const prisma = this.runtime.prisma;
    const [tenant, theme, domain] = await runAsTenant(
      tenantId,
      () =>
        Promise.all([
          prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
          prisma.modThemingTenantTheme.findUnique({
            where: { tenantId },
            select: {
              brandHue: true,
              brandSaturation: true,
              logoStorageKey: true,
              logoDisplayMode: true,
            },
          }),
          prisma.tenantDomain.findFirst({
            where: { tenantId, isPrimary: true, isVerified: true, surface: 'APP' },
            select: { hostname: true },
          }),
        ]),
      { traceLabel: 'payouts-branding' },
    );
    if (!tenant) return null;
    const primary = theme ? brandPrimaryHex(theme.brandHue, theme.brandSaturation) : null;

    let icon: PayoutsBrandImage | null = null;
    let logo: PayoutsBrandImage | null = null;
    if (theme?.logoStorageKey) {
      const source = await this.logoBytes(tenantId);
      if (source) {
        icon = await squareIcon(source);
        // Solo el logo que ya lleva el nombre sustituye al nombre en Stripe.
        if (theme.logoDisplayMode === 'logo_only') logo = await wordmarkLogo(source);
      }
    }
    return {
      name: tenant.name,
      primaryColor: primary,
      secondaryColor: primary,
      icon,
      logo,
      // La web del negocio: la dirección del aula de AHORA. Si el aula la
      // cambia, la siguiente sincronización la pone al día en Stripe.
      businessUrl: publicBusinessUrl(domain?.hostname),
    };
  }

  private async logoBytes(tenantId: string): Promise<Buffer | null> {
    try {
      const registry = this.moduleRef?.get(ModuleRegistryService, { strict: false });
      if (!registry) return null;
      const blob = await runAsTenant(tenantId, () =>
        registry.getThemingService().getLogoBlob(tenantId),
      );
      return blob.buffer;
    } catch {
      return null;
    }
  }
}
