import { Module } from '@nestjs/common';
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
  ],
  exports: [
    AuthService,
    TokenService,
    PasswordService,
    MfaService,
    ApiKeyService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
  ],
})
export class AuthModule {}
