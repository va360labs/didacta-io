#!/usr/bin/env node
// Verificación independiente de la firma ES256 del ZIP migrator 1.0.28.
// Lee manifest.jwt del ZIP y lo valida contra la public key embebida en
// packages/license-sdk/src/public-keys/didacta-issuer-2026.pem.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importSPKI, jwtVerify } from 'jose';

const ROOT = resolve(import.meta.dirname, '..');
const JWT_PATH = resolve(ROOT, 'work/manifest.jwt');
const PEM_PATH = resolve(ROOT, 'packages/license-sdk/src/public-keys/didacta-issuer-2026.pem');

const jwt = readFileSync(JWT_PATH, 'utf8').trim();
const pem = readFileSync(PEM_PATH, 'utf8');

const key = await importSPKI(pem, 'ES256');

try {
  const { payload, protectedHeader } = await jwtVerify(jwt, key, {
    issuer: 'didacta.io',
    audience: 'didacta-marketplace',
  });

  console.log('=== Firma ES256 verificada ===');
  console.log('protectedHeader:', JSON.stringify(protectedHeader));
  console.log('');
  console.log('=== Payload (manifest del modulo) ===');
  console.log(JSON.stringify(payload, null, 2));
  console.log('');
  console.log('=== Checks ===');
  console.log('vendor =', payload.vendor, payload.vendor === 'didacta' ? '(OK)' : '(WRONG)');
  console.log('name   =', payload.name, payload.name === 'migrator-learndash' ? '(OK)' : '(WRONG)');
  console.log('version=', payload.version);
  console.log('iss    =', payload.iss);
  console.log('aud    =', payload.aud);
  process.exit(0);
} catch (e) {
  console.error('=== Verificacion FALLO ===');
  console.error(e.message);
  process.exit(1);
}
