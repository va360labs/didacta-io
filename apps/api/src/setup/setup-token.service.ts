/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaInstanceConfigService } from '../modules/prisma-instance-config.service';
import { PrismaService } from '../prisma/prisma.service';

const SCOPE = 'setup';
const KEY = 'init-token-hash';

/**
 * Token de un solo uso que protege `POST /setup/init` mientras la instancia
 * está virgen (cero tenants). Sin esto, cualquiera que gane la carrera de red
 * hasta `/setup/init` antes que el operador legítimo se queda con la cuenta
 * super_admin — el endpoint es público por diseño (ver doc-comment de
 * `SetupService`) porque el tenant todavía no existe para autenticar contra él.
 *
 * Al arrancar (`onApplicationBootstrap`, mismo hook que usa `LicenseBootstrap`
 * de `@didacta/license-sdk` para leer la licencia desde `instance_setting`) se
 * genera un token nuevo SOLO si todavía no hay ningún tenant, se guarda su
 * SHA-256 en `core_instance_setting` (scope=setup) y se imprime el valor en
 * plano por el logger — `docker logs` es lo único que el operador puede leer
 * antes de tener UI. Un reinicio del contenedor antes de completar el wizard
 * simplemente reemplaza el token anterior por uno nuevo (el operador siempre
 * usa el de los logs más recientes).
 */
@Injectable()
export class SetupTokenService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SetupTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PrismaInstanceConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Mismo criterio que `SetupService.getStatus()`: la tabla `tenant` es
    // global (no lleva tenant_id, define la identidad de tenant), así que no
    // requiere `runSanctionedGlobalAccess`.
    const tenantsCount = await this.prisma.tenant.count({ where: { deletedAt: null } });
    if (tenantsCount > 0) return;

    const plain = await this.issue();
    this.logger.warn(
      `Setup token (un solo uso, obligatorio para completar POST /setup/init): ${plain}\n` +
        `Ábrelo con /setup?token=${plain} — no se vuelve a imprimir salvo que la instancia reinicie sin haberse inicializado.`,
    );
  }

  /** Genera un token nuevo, persiste su hash (sustituye al anterior si había) y devuelve el valor en plano. */
  async issue(): Promise<string> {
    const plain = randomBytes(32).toString('base64url');
    await this.settings.set(SCOPE, KEY, this.hash(plain));
    return plain;
  }

  /** Lanza 403 si `candidate` es nulo/vacío o no coincide con el token vigente. */
  async assertValid(candidate: string | null | undefined): Promise<void> {
    if (!candidate) {
      throw new ForbiddenException({
        code: 'SETUP_TOKEN_REQUIRED',
        message:
          'Falta el token de setup. Consulta los logs del contenedor del primer arranque (docker logs).',
      });
    }

    const storedHash = await this.settings.get<string>(SCOPE, KEY);
    if (!storedHash || !this.matches(candidate, storedHash)) {
      throw new ForbiddenException({
        code: 'SETUP_TOKEN_INVALID',
        message: 'Token de setup inválido o ya usado.',
      });
    }
  }

  /** Cierra el token tras un `init()` exitoso — de un solo uso. */
  async invalidate(): Promise<void> {
    await this.settings.delete(SCOPE, KEY);
  }

  private hash(plain: string): string {
    return createHash('sha256').update(plain).digest('hex');
  }

  private matches(candidate: string, storedHash: string): boolean {
    const candidateHash = Buffer.from(this.hash(candidate), 'hex');
    const stored = Buffer.from(storedHash, 'hex');
    if (candidateHash.length !== stored.length) return false;
    return timingSafeEqual(candidateHash, stored);
  }
}
