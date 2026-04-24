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
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  app.setGlobalPrefix('api/v1', {
    exclude: ['healthz', 'readyz', 'api/docs'],
  });

  const config = new DocumentBuilder()
    .setTitle('LearnShip API')
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
  logger.log(`LearnShip API escuchando en http://localhost:${port}`);
  logger.log(`Docs OpenAPI: http://localhost:${port}/api/docs`);
}

bootstrap().catch((err: unknown) => {
  console.error('Error al arrancar la API:', err);
  process.exit(1);
});
