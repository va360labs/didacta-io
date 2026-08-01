/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { TelegramVerifier } from '@didacta/mod-member-registration';

/**
 * Wrapper NestJS del verificador de Telegram del módulo: la lógica (firma del
 * Login Widget + getChatMember) vive en `modules/member-registration/`; aquí
 * solo se inyecta el logger del host (compatible con el puerto del paquete).
 */
@Injectable()
export class TelegramService extends TelegramVerifier {
  constructor(logger: PinoLogger) {
    super(logger);
  }
}
