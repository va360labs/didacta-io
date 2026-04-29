import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { LicenseExceptionFilter } from '@didacta/license-sdk';
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

  // Fastify por default rechaza con 400 cualquier request que llegue con
  // `Content-Type: application/json` y body vacío. Eso rompe llamadas
  // POST/DELETE válidas que mandan headers de JSON sin payload (común en
  // muchos clientes HTTP y librerías de tests). Reemplazamos el parser
  // que Nest registra en su init por uno que mapea body vacío → null
  // (Nest lo trata como "sin body" y el validador Zod del DTO recibe
  // lo que corresponda).
  //
  // El parser de NestFastifyApplication recibe el body como Buffer; lo
  // convertimos a string para hacer el JSON.parse. El parseAs por
  // default es 'buffer' (no exponible en NestFastifyBodyParserOptions).
  app.useBodyParser(
    'application/json',
    {},
    (_req, body: Buffer, done: (err: Error | null, result?: unknown) => void) => {
      if (!body || body.length === 0) {
        done(null, null);
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.useLogger(app.get(Logger));

  // Habilita lifecycle hooks (onModuleDestroy) para cerrar limpio la conexión
  // de BullMQ + Redis cuando el contenedor recibe SIGTERM (Easypanel deploy).
  app.enableShutdownHooks();

  app.setGlobalPrefix('api/v1', {
    exclude: [
      'healthz',
      'readyz',
      'livez',
      'api/docs',
      'metrics',
      // License public endpoint vive en /api/license (sin versión) para que
      // el frontend lo consuma sin tener que conocer la versión actual del API.
      'api/license',
    ],
  });

  // Captura CapabilityRequiredError y LicenseSignatureError, mapea a HTTP 402/401
  // con body JSON estructurado.
  app.useGlobalFilters(new LicenseExceptionFilter());

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
