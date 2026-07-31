/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * BrandingService — opciones de branding básico disponibles en Community.
 *
 * En Community el branding es estático: logo Didacta, colores por defecto,
 * footer "Powered by Didacta". El cliente puede subir su propio logo si quiere
 * pero NO puede ocultar la marca Didacta — eso requiere la capability EE
 * `feat:white_label`.
 *
 * Para el piloto v0.0.1, el estado se guarda en memoria. La persistencia
 * en BBDD vendrá cuando el módulo de branding se solidifique.
 */

import { Injectable } from '@nestjs/common';

export interface PublicBrandingOptions {
  logoUrl: string;
  primaryColor: string;
  poweredByDidacta: boolean;
  whiteLabelEnabled: boolean;
}

@Injectable()
export class BrandingService {
  private logoUrl = '/assets/didacta-logo.svg';
  private primaryColor = '#2563eb';
  private poweredByDidacta = true;

  /**
   * Devuelve las opciones públicas de branding para que el frontend renderice
   * el header / footer correctamente. El flag `whiteLabelEnabled` lo decide
   * el WhiteLabelService (si está cargado).
   */
  getPublicOptions(whiteLabelEnabled: boolean): PublicBrandingOptions {
    return {
      logoUrl: this.logoUrl,
      primaryColor: this.primaryColor,
      poweredByDidacta: whiteLabelEnabled ? this.poweredByDidacta : true,
      whiteLabelEnabled,
    };
  }

  setLogoUrl(url: string): void {
    this.logoUrl = url;
  }

  setPrimaryColor(color: string): void {
    this.primaryColor = color;
  }

  setPoweredByDidacta(visible: boolean): void {
    // Sin licencia EE, esta llamada se ignora — siempre visible en CE.
    this.poweredByDidacta = visible;
  }

  getRawState() {
    return {
      logoUrl: this.logoUrl,
      primaryColor: this.primaryColor,
      poweredByDidacta: this.poweredByDidacta,
    };
  }
}
