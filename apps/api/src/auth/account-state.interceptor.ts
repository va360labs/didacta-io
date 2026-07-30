import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { AccountStateService } from './account-state.service';

/**
 * Corta las peticiones de credenciales que ya no valen: cuentas suspendidas o
 * borradas, y sesiones cerradas.
 *
 * Va como interceptor global —igual que `ModuleAccessInterceptor` y
 * `RestrictionInterceptor`— porque necesita `request.user`, que se popula en
 * los guards de controller. Así cubre también las rutas que no pasan por
 * `JwtAuthGuard`.
 *
 * A diferencia del de sanciones, este mira TODAS las peticiones y no solo las
 * mutantes: una cuenta suspendida tampoco debe poder leer.
 *
 * Devuelve 401 y no 403 a propósito: el cliente ya sabe limpiar la sesión y
 * mandar a /signin ante un 401, que es justo lo que toca aquí.
 */
@Injectable()
export class AccountStateInterceptor implements NestInterceptor {
  constructor(private readonly accounts: AccountStateService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const user = request.user;
    // Sin user es ruta pública: el guard ya habrá rechazado si tocaba.
    if (!user?.sub) return next.handle();

    // El propio flujo de auth queda fuera: un suspendido tiene que poder
    // cerrar sesión, y el refresh ya valida el estado por su cuenta.
    const path = (request.url ?? '').split('?', 1)[0] ?? '';
    if (path.includes('/auth/')) return next.handle();

    const rejection = await this.accounts.check(user.sub, user.sid);
    if (rejection) {
      throw new UnauthorizedException({ code: rejection.code, message: rejection.message });
    }
    return next.handle();
  }
}
