import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from './decorators';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MfaService } from './mfa.service';
import { TokenService, type SessionClaims } from './token.service';
import { ZodValidationPipe } from './zod-validation.pipe';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

const enableSchema = z.object({
  code: z
    .string()
    .min(6)
    .max(6)
    .regex(/^\d{6}$/),
});
const verifySchema = z.object({
  code: z.string().min(6).max(10),
});

@ApiTags('Auth · MFA')
@ApiBearerAuth()
@Controller('auth/mfa')
@UseGuards(JwtAuthGuard)
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Post('setup')
  @ApiOperation({ summary: 'Generar nuevo secreto TOTP + recovery codes (no activa MFA todavía)' })
  async setup(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const dbUser = await this.prisma.user.findUnique({ where: { id: user.sub } });
    if (!dbUser) throw new UnauthorizedException();

    const setup = await this.mfa.generateSetup(dbUser.email);
    await this.prisma.user.update({
      where: { id: user.sub },
      data: {
        mfaSecret: setup.secret,
        mfaEnabled: false,
        mfaRecoveryCodes: setup.recoveryCodes,
      },
    });

    return {
      otpauthUrl: setup.otpauthUrl,
      qrCodeDataUrl: setup.qrCodeDataUrl,
      recoveryCodes: setup.recoveryCodes,
    };
  }

  @Post('enable')
  @ApiOperation({ summary: 'Confirmar el setup verificando el primer código TOTP' })
  async enable(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(enableSchema)) body: z.infer<typeof enableSchema>,
  ) {
    if (!user) throw new UnauthorizedException();
    const dbUser = await this.prisma.user.findUnique({ where: { id: user.sub } });
    if (!dbUser?.mfaSecret) throw new BadRequestException('Setup no iniciado');

    const valid = this.mfa.verifyCode(dbUser.mfaSecret, body.code);
    if (!valid) throw new ForbiddenException('Código TOTP incorrecto');

    await this.prisma.user.update({
      where: { id: user.sub },
      data: { mfaEnabled: true },
    });

    await this.auditLog.record({
      tenantId: user.tenantId,
      actorId: user.sub,
      action: 'user.mfa.enabled',
      resourceType: 'user',
      resourceId: user.sub,
    });

    const tokens = await this.tokens.sign({
      sub: user.sub,
      tenantId: user.tenantId,
      roles: user.roles,
      mfaVerified: true,
    });

    return { enabled: true, tokens };
  }

  @Post('verify')
  @ApiOperation({ summary: 'Verificar el segundo factor para elevar la sesión a mfaVerified=true' })
  async verify(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(verifySchema)) body: z.infer<typeof verifySchema>,
  ) {
    if (!user) throw new UnauthorizedException();
    const dbUser = await this.prisma.user.findUnique({ where: { id: user.sub } });
    if (!dbUser?.mfaSecret || !dbUser.mfaEnabled) {
      throw new BadRequestException('MFA no está activo para este usuario');
    }

    const sanitized = body.code.replace(/\s+/g, '');
    let success = false;
    let updatedRecoveryCodes: string[] | null = null;

    if (/^\d{6}$/.test(sanitized)) {
      success = this.mfa.verifyCode(dbUser.mfaSecret, sanitized);
    } else {
      const result = this.mfa.consumeRecoveryCode(dbUser.mfaRecoveryCodes, sanitized);
      success = result.valid;
      if (result.valid) updatedRecoveryCodes = result.remaining;
    }

    if (!success) {
      await this.auditLog.record({
        tenantId: user.tenantId,
        actorId: user.sub,
        action: 'user.mfa.verify.failed',
        resourceType: 'user',
        resourceId: user.sub,
      });
      throw new ForbiddenException('Código incorrecto');
    }

    if (updatedRecoveryCodes) {
      await this.prisma.user.update({
        where: { id: user.sub },
        data: { mfaRecoveryCodes: updatedRecoveryCodes },
      });
    }

    await this.auditLog.record({
      tenantId: user.tenantId,
      actorId: user.sub,
      action: 'user.mfa.verify.success',
      resourceType: 'user',
      resourceId: user.sub,
      metadata: { usedRecoveryCode: !!updatedRecoveryCodes },
    });

    const tokens = await this.tokens.sign({
      sub: user.sub,
      tenantId: user.tenantId,
      roles: user.roles,
      mfaVerified: true,
    });

    return { verified: true, tokens };
  }
}
