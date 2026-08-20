/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/// Extension point de `mod.hello-world` hacia el core.
///
/// `hello-world` es el módulo de referencia del contrato: existe para que
/// cada capacidad nueva tenga un consumidor mínimo y comprobable sin
/// depender de un módulo real a medio construir. Aquí estrena la superficie
/// `publico`.
///
/// La ruta solo se monta si el módulo está habilitado para el tenant Y el
/// dominio de entrada sirve el sitio público, así que una instalación que no
/// lo active no publica nada.

import type { ModuleWebExtension } from '@/lib/module-registry';
import { HelloWorldPublicPage } from './public-page';

export const helloWorldExtension: ModuleWebExtension = {
  name: 'mod.hello-world',
  publicRoutes: [
    {
      pattern: '/hello-world',
      Component: HelloWorldPublicPage,
    },
  ],
};
