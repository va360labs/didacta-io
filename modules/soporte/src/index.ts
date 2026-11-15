/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DidactaModule, ModuleContext } from '@didacta/core-kernel';
import { manifest } from './manifest.js';
import { SoporteService } from './soporte.service.js';

export { manifest };
export {
  DESTINOS_TICKET,
  ESTADOS_CERRADOS,
  ESTADOS_TICKET,
  LIMITES,
  PLANTILLA_TICKET_ESTADO,
  PLANTILLA_TICKET_NUEVO,
  RUTA_BANDEJA,
  RUTA_MIS_TICKETS,
  SoporteService,
  TIPOS_TICKET,
  destinoDe,
  extracto,
  marcasEstado,
  marcasTipo,
  validarTexto,
  type AdminFiltros,
  type AdminListado,
  type AdminTicketView,
  type AutorTicket,
  type AvisoOperadorTicket,
  type CanalSoporte,
  type DestinoTicket,
  type Caller,
  type CambiosAdmin,
  type CapturaArchivo,
  type ContextoInput,
  type EstadoTicket,
  type SoporteCapturaStorage,
  type SoportePorts,
  type TicketInput,
  type TicketView,
  type TipoTicket,
} from './soporte.service.js';
export {
  CAPTURA_MAX_BYTES,
  CAPTURA_TIPOS,
  validarCaptura,
  type CapturaInput,
  type CapturaTipo,
} from './captura.js';
export {
  CapturaInvalidaError,
  LimiteDiarioError,
  SinPermisoError,
  SOPORTE_ERROR_CODES,
  SoporteError,
  TextoInvalidoError,
  TicketNoEncontradoError,
  type MotivoCapturaInvalida,
  type MotivoTextoInvalido,
} from './errors.js';

/**
 * Módulo mod.soporte. Recibe el service ya construido por el host; hoy no se
 * suscribe a ningún evento.
 */
export function buildSoporteModule(service: SoporteService): DidactaModule {
  void service;
  return {
    manifest,

    async onRegister(ctx: ModuleContext) {
      ctx.logger.info('mod.soporte: onRegister', { name: manifest.name });
    },

    async onEnable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.soporte: onEnable', { tenantId });
    },

    async onDisable(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.soporte: onDisable', { tenantId });
    },

    async onUninstall(tenantId: string, ctx: ModuleContext) {
      ctx.logger.info('mod.soporte: onUninstall', { tenantId });
    },
  };
}
