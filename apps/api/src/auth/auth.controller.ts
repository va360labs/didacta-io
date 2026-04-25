import { Body, Controller, Post, UsePipes } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
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
  @UsePipes(new ZodValidationPipe(signupSchema))
  async signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Post('signin')
  @ApiOperation({ summary: 'Iniciar sesión con email + password' })
  @UsePipes(new ZodValidationPipe(signinSchema))
  async signin(@Body() dto: SigninDto) {
    return this.auth.signin(dto);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Renovar access token con un refresh token' })
  @UsePipes(new ZodValidationPipe(refreshSchema))
  async refresh(@Body() dto: RefreshDto) {
    const tokens = await this.auth.refresh(dto.refreshToken);
    return { tokens };
  }
}
