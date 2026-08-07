/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { LicenseExceptionFilter } from '@didacta/license-sdk';
import { AppModule } from './app.module';
import { HttpExceptionNormalizerFilter } from './common/http-exception-normalizer.filter';

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
  //
  // `bodyLimit` 16 MB: el default de Fastify es 1 MB. Varios uploads viajan como
  // base64 dentro de un JSON y base64 infla el binario ~33%:
  //   - logo de mod.theming (`POST /modules/theming/me/logo`): hasta 2 MB.
  //   - adjuntos del compositor de comunidad (`POST /storage/upload`): hasta 10 MB
  //     (pptx, zip, pdf…), que como base64 son ~13.4 MB + overhead JSON.
  // Sin un límite acorde, Fastify rechaza el request con 413 FST_ERR_CTP_BODY_TOO_LARGE
  // ANTES de llegar al handler; con el proxy delante eso se vive como un upload que
  // se queda colgado para siempre (no como un error). 16 MB cubre el peor caso del
  // upload de 10 MB con headroom; el resto de endpoints siguen acotados por la
  // validación Zod de su DTO (un JSON grande a un endpoint que no lo espera se rechaza).
  app.useBodyParser(
    'application/json',
    { bodyLimit: 16 * 1024 * 1024 },
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

  // SAML ACS callback (9º piloto License SDK · feat:sso.saml) llega como POST
  // con `application/x-www-form-urlencoded` y los campos `SAMLResponse` +
  // `RelayState`. Sin este parser, el body llega como Buffer crudo y Nest no
  // puede inyectarlo en @Body(). Registramos un parser que devuelve un objeto
  // plano `{ SAMLResponse, RelayState }`.
  // Marketplace de módulos (ADR-009): el endpoint `POST /admin/modules/install`
  // recibe el `*.zip` como body crudo `application/zip`. El parser
  // por defecto no maneja este content-type — sin esto Fastify devolvería
  // 415. `bodyLimit` se aliña con `MAX_PACKAGE_BYTES` del validador (50MB);
  // si el ZIP excede el límite, Fastify rechaza antes de llegar al handler.
  app.useBodyParser(
    'application/zip',
    { bodyLimit: 50 * 1024 * 1024 },
    (_req, body: Buffer, done: (err: Error | null, result?: unknown) => void) => {
      done(null, body);
    },
  );

  app.useBodyParser(
    'application/x-www-form-urlencoded',
    {},
    (_req, body: Buffer, done: (err: Error | null, result?: unknown) => void) => {
      if (!body || body.length === 0) {
        done(null, {});
        return;
      }
      try {
        const params = new URLSearchParams(body.toString('utf8'));
        const obj: Record<string, string> = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        done(null, obj);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.useLogger(app.get(Logger));

  // Habilita lifecycle hooks (onModuleDestroy) para cerrar limpio la conexión
  // de BullMQ + Redis cuando el contenedor recibe SIGTERM (redeploy).
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
      // SCIM 2.0 vive en /scim/v2/* sin prefijo /api/v1 — los IdPs (Okta,
      // Azure AD, Auth0, Google Workspace) esperan exactamente esa forma
      // canónica del path RFC 7644. Séptimo piloto License SDK (feat:scim).
      // Sintaxis de wildcard nombrado de path-to-regexp v8 (Nest 11).
      'scim/v2/{*path}',
    ],
  });

  // Captura CapabilityRequiredError y LicenseSignatureError, mapea a HTTP 402/401
  // con body JSON estructurado.
  // El normalizador va PRIMERO (menor precedencia en Nest: el último filter
  // registrado que casa gana): garantiza `{ statusCode, code?, message }` en
  // toda HttpException sin pisar al filter de licencia ni a los de dominio.
  app.useGlobalFilters(new HttpExceptionNormalizerFilter(), new LicenseExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle('Didacta API')
    .setDescription('API REST de Didacta, el LMS modular fair-code')
    .setVersion('v1')
    .addBearerAuth()
    // Esquema para integradores externos: el header Authorization lleva
    // `ApiKey lmsk_xxx` (clave creada por el admin en Administración → Claves API).
    // Lo usa, p.ej., `POST /api/v1/inscribe`.
    .addApiKey(
      {
        type: 'apiKey',
        name: 'Authorization',
        in: 'header',
        description: 'Formato del valor: `ApiKey lmsk_xxx`',
      },
      'ApiKey',
    )
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
