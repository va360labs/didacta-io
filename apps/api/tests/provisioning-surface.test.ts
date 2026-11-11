/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * UC-C103 AC2 — **superficie** de la credencial de provisioning.
 *
 * Este es el test que impide que el alcance se ensanche por descuido. La
 * credencial no tiene tenant ni usuario: cada ruta que abre es una operación
 * que una máquina puede hacer sobre TODA la instalación. Añadir un
 * `@AllowProvisioning()` en cualquier sitio del código, o poner el guard en
 * otro controller, rompe este test a propósito — la lista de abajo hay que
 * tocarla a mano, mirando lo que se está abriendo.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AdminTenantsController } from '../src/admin/admin-tenants.controller';
import { AdminSystemController } from '../src/modules/admin-system.controller';
import { ALLOW_PROVISIONING_KEY } from '../src/auth/jwt-or-provisioning.guard';

/**
 * Las 11 operaciones que el plano de control necesita para dar de alta, operar,
 * facturar y sostener un tenant. Ni una más.
 *
 * `setSignups` (U7) se añadió el 2026-08-12 a conciencia: congelar altas es el
 * enforcement del techo de plan, y esa decisión la toma el plano de control
 * desde fuera. El núcleo solo obedece un interruptor — no cuenta miembros ni
 * mira licencias, y `signup-freeze.test.ts` lo vigila.
 *
 * `grantSupportAccess` y `revokeSupportAccess` (U8) se añadieron el mismo día,
 * y son las dos que más merecen que alguien las mire dos veces: abren la puerta
 * del aula de un cliente. Lo que las hace aceptables no es el guard, es lo que
 * la operación puede y no puede hacer —≤ 15 min, un solo uso, motivo
 * obligatorio, usuario de soporte propio en vez de suplantar a nadie, dos filas
 * en el audit log DEL TENANT y un aviso permanente en el aula— y todo eso lo
 * fija `support-access.test.ts`. Van juntas a propósito: abrir sin poder cerrar
 * dejaría al operador esperando a que caduque cuando se equivoque de tenant.
 *
 * `setSubscriptionGate` (2026-11-11) es la prueba gratis de Didacta Cloud: el
 * plano de control abre, pone en prueba o cierra el aula según su cuenta. Como
 * `setSignups`, el núcleo solo obedece: no cuenta días ni mira planes, y
 * `subscription-gate.test.ts` lo vigila. No toca `status` ni las sesiones; lo
 * peor que puede hacer es dejar un aula en pausa, y el mismo PUT la reabre.
 */
const WHITELIST = [
  'list',
  'usage',
  'getOne',
  'create',
  'setStatus',
  'setSignups',
  'setSubscriptionGate',
  'grantSupportAccess',
  'revokeSupportAccess',
  'addDomain',
  'removeDomain',
];

/**
 * Rutas de `AdminTenantsController` que NO abre la credencial, con el porqué:
 *  - `capacity`: informa del cupo de licencia del operador, no de provisioning.
 *  - `rename`: decisión de negocio del humano que opera la academia.
 */
const DENIED = ['capacity', 'rename'];

/**
 * El SEGUNDO controller que abre la credencial, y hasta el 2026-08-12 el único
 * con `JwtAuthGuard` a secas. Solo una ruta, y de solo lectura.
 *
 * Se abrió para desbloquear UC-C504: el plano de control no puede operar un
 * pool a ciegas, y «¿este nodo va bien?» no se responde entrando a mano. Lo que
 * devuelve son latencias, contadores de las dos colas y la versión desplegada
 * — ni un dato de un alumno, ni una escritura. Si algún día aparece aquí una
 * ruta que escriba, este test es el sitio donde hay que pararse a discutirlo.
 */
const SYSTEM_WHITELIST = ['healthDetail'];

const SRC_ROOT = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const TS_FILES = walk(SRC_ROOT).filter((f) => f.endsWith('.ts'));

/** Ficheros de `src/` cuyo contenido casa con el patrón, en ruta POSIX. */
function filesMatching(pattern: RegExp): string[] {
  return TS_FILES.filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC_ROOT, file).split(sep).join('/'))
    .sort();
}

/** Handlers del controller según la metadata de Nest (no una lista escrita a mano). */
function routeHandlersOf(controller: new (...args: never[]) => unknown): string[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .filter((name) => {
      const handler = proto[name];
      return (
        typeof handler === 'function' &&
        Reflect.getMetadata(PATH_METADATA, handler) !== undefined &&
        Reflect.getMetadata(METHOD_METADATA, handler) !== undefined
      );
    });
}

function isAllowed(controller: new (...args: never[]) => unknown, handler: string): boolean {
  const proto = controller.prototype as Record<string, unknown>;
  return Reflect.getMetadata(ALLOW_PROVISIONING_KEY, proto[handler] as object) === true;
}

describe('UC-C103 AC2 · superficie de la credencial de provisioning', () => {
  it('abre exactamente las 11 rutas de la lista blanca en AdminTenantsController', () => {
    const abiertas = routeHandlersOf(AdminTenantsController).filter((h) =>
      isAllowed(AdminTenantsController, h),
    );
    expect(abiertas.sort()).toEqual([...WHITELIST].sort());
  });

  it('cubre TODAS las rutas del controller: cada una está abierta o denegada, sin olvidos', () => {
    const todas = routeHandlersOf(AdminTenantsController).sort();
    expect(todas).toEqual([...WHITELIST, ...DENIED].sort());
  });

  it('las rutas denegadas no llevan la marca', () => {
    for (const handler of DENIED) {
      expect(isAllowed(AdminTenantsController, handler)).toBe(false);
    }
  });

  it('abre exactamente una ruta, y de solo lectura, en AdminSystemController', () => {
    const abiertas = routeHandlersOf(AdminSystemController).filter((h) =>
      isAllowed(AdminSystemController, h),
    );
    expect(abiertas.sort()).toEqual([...SYSTEM_WHITELIST].sort());
    // Y esa ruta es un GET. Una escritura alcanzable con la credencial en el
    // controller de salud del sistema sería otra conversación entera.
    for (const handler of abiertas) {
      const fn = (AdminSystemController.prototype as unknown as Record<string, unknown>)[handler];
      expect(Reflect.getMetadata(METHOD_METADATA, fn as object)).toBe(0); // RequestMethod.GET
    }
  });

  it('los dos ÚNICOS ficheros con @AllowProvisioning() son los declarados aquí', () => {
    // Línea entera, no `includes`: si no, los doc-comments que lo citan en
    // prosa (el guard, el service) darían falsos positivos.
    const conMarca = filesMatching(/^\s*@AllowProvisioning\(\)\s*$/m);
    expect(conMarca).toEqual([
      'admin/admin-tenants.controller.ts',
      'modules/admin-system.controller.ts',
    ]);
  });

  it('el guard que acepta la credencial solo protege esos dos controllers', () => {
    const conGuard = filesMatching(/^\s*@UseGuards\(JwtOrProvisioningGuard\)\s*$/m);
    expect(conGuard).toEqual([
      'admin/admin-tenants.controller.ts',
      'modules/admin-system.controller.ts',
    ]);
  });

  it('emitir y revocar la credencial NO es alcanzable con la propia credencial', () => {
    const source = readFileSync(
      join(SRC_ROOT, 'admin', 'admin-provisioning.controller.ts'),
      'utf8',
    );
    // Una credencial que puede rotarse a sí misma no se puede revocar de verdad.
    expect(source).toContain('@UseGuards(JwtAuthGuard)');
    expect(source).not.toContain('AllowProvisioning');
  });
});
