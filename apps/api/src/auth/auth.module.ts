import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController, MfaController],
  providers: [AuthService, PasswordService, TokenService, MfaService, JwtAuthGuard],
  exports: [AuthService, TokenService, PasswordService, MfaService, JwtAuthGuard],
})
export class AuthModule {}
