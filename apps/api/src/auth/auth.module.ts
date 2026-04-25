import { Module } from '@nestjs/common';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { ApiKeyController } from './api-key.controller';
import { JwtOrApiKeyGuard } from './api-key.guard';
import { ApiKeyService } from './api-key.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController, MfaController, ApiKeyController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    MfaService,
    ApiKeyService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    PrismaAuditLogService,
  ],
  exports: [
    AuthService,
    TokenService,
    PasswordService,
    MfaService,
    ApiKeyService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    PrismaAuditLogService,
  ],
})
export class AuthModule {}
