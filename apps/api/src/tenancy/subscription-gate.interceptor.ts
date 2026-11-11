/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { resolvePublicHost } from '../common/resolve-public-host';
import { isGateExempt, SUBSCRIPTION_LOCKED_CODE } from './subscription-gate';
import { SubscriptionGateService } from './subscription-gate.service';
import { tenantContextStorage } from './tenant-context.storage';

/**
 * El bloqueo REAL de la puerta de suscripción: con la puerta cerrada (o la
 * prueba vencida), la API contesta `402 { code: "SUBSCRIPTION_LOCKED" }` a todo
 * lo que sea contenido del aula. Pintar una pantalla de pausa en el navegador
 * sin esto sería decorado: la API seguiría sirviendo cursos a quien la llamase.
 *
 * Interceptor global, como `AccountStateInterceptor`, porque necesita
 * `request.user` y eso lo pone el guard del controller. El tenant sale, por
 * orden: del token verificado, del token SCIM, del contexto que abrió el
 * middleware (Bearer o ApiKey) y, para las peticiones sin sesión —catálogo público, sitio,
 * checkout—, del host por el que entran.
 *
 * Quedan fuera:
 *  - la credencial de provisioning (opera la instalación, no un aula);
 *  - las rutas de `SUBSCRIPTION_GATE_EXEMPT`: entrar, saber quién eres, la
 *    marca, el estado de la puerta, las sondas y los webhooks entrantes;
 *  - todo lo que no es HTTP: colas, cron y bridges de eventos no pasan por
 *    aquí, y un aula en pausa sigue procesando lo que tenga pendiente.
 *
 * Con todas las puertas abiertas —Community siempre— no resuelve ni el host:
 * la foto de puertas cerradas está vacía y la petición sigue sin más.
 */
@Injectable()
export class SubscriptionGateInterceptor implements NestInterceptor {
  constructor(private readonly gate: SubscriptionGateService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.provisioningActor) return next.handle();
    if (isGateExempt(request.method, request.url)) return next.handle();
    if (!(await this.gate.anyGated())) return next.handle();

    const tenantId =
      request.user?.tenantId ??
      request.scimTenantId ??
      tenantContextStorage.getStore()?.tenantId ??
      (await this.gate.tenantIdForHost(resolvePublicHost(request)));
    if (!tenantId) return next.handle();

    const { state } = await this.gate.gateFor(tenantId);
    if (state === 'LOCKED') {
      throw new HttpException(
        {
          code: SUBSCRIPTION_LOCKED_CODE,
          message:
            'El acceso a esta academia está en pausa. Sus responsables pueden reactivarla eligiendo un plan.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return next.handle();
  }
}
