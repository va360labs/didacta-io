import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    // `rawBody: true` expone `req.rawBody` (Buffer) en cada request; lo
    // necesita el webhook de Zoom para verificar HMAC sobre el body
    // exacto recibido (no el JSON re-serializado).
    { bufferLogs: true, rawBody: true },
  );

  app.useLogger(app.get(Logger));

  // Habilita lifecycle hooks (onModuleDestroy) para cerrar limpio la conexión
  // de BullMQ + Redis cuando el contenedor recibe SIGTERM (Easypanel deploy).
  app.enableShutdownHooks();

  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'readyz', 'livez', 'api/docs'],
  });

  const config = new DocumentBuilder()
    .setTitle('Didacta API')
    .setDescription('API REST del LMS modular de VA360 LABS')
    .setVersion('v1')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs.json',
  });

  const port = Number(process.env['API_PORT'] ?? 4000);
  await app.listen(port, '0.0.0.0');

  const logger = app.get(Logger);
  logger.log(`Didacta API escuchando en http://localhost:${port}`);
  logger.log(`Docs OpenAPI: http://localhost:${port}/api/docs`);
}

bootstrap().catch((err: unknown) => {
  console.error('Error al arrancar la API:', err);
  process.exit(1);
});
