import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { extractClientContext } from './client-context';
import {
  signinSchema,
  signupSchema,
  refreshSchema,
  type SigninDto,
  type SignupDto,
  type RefreshDto,
} from './dto';
import { ZodValidationPipe } from './zod-validation.pipe';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @ApiOperation({ summary: 'Registrar un usuario en un tenant existente' })
  async signup(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(signupSchema)) dto: SignupDto,
  ) {
    return this.auth.signup(dto, extractClientContext(req));
  }

  @Post('signin')
  @ApiOperation({ summary: 'Iniciar sesión con email + password' })
  async signin(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(signinSchema)) dto: SigninDto,
  ) {
    return this.auth.signin(dto, extractClientContext(req));
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Renovar access token con un refresh token' })
  async refresh(@Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto) {
    const tokens = await this.auth.refresh(dto.refreshToken);
    return { tokens };
  }
}
