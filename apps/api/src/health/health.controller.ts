import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptime: number;
  timestamp: string;
}

@ApiTags('Health')
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ description: 'El servicio está vivo.' })
  healthz(): HealthResponse {
    return {
      status: 'ok',
      service: 'api',
      version: process.env['npm_package_version'] ?? '0.0.0',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiOkResponse({ description: 'El servicio está listo para aceptar tráfico.' })
  readyz(): HealthResponse {
    return this.healthz();
  }
}
