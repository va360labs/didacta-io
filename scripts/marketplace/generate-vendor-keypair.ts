#!/usr/bin/env -S node --import tsx
/* eslint-disable no-console */

/// Genera un par RSA-2048 para firmar paquetes `*.didactamod` del vendor
/// `va360`. Uso DEV / staging — la clave de PRODUCCIÓN debe vivir en un
/// KMS/HSM, NO en disco. Ver ADR-009 §"Pre-requisitos no negociables".
///
/// Uso:
///   pnpm tsx scripts/marketplace/generate-vendor-keypair.ts <outDir>
///
/// Genera dos archivos:
///   <outDir>/va360-marketplace-private.pem
///   <outDir>/va360-marketplace-public.pem
///
/// La clave pública debe inyectarse en la instancia via env var
/// `MARKETPLACE_TRUSTED_VENDOR_KEYS_VA360` (contenido del PEM).

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const outDir = resolve(process.cwd(), process.argv[2] ?? './secrets/marketplace');
  mkdirSync(outDir, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const privatePath = resolve(outDir, 'va360-marketplace-private.pem');
  const publicPath = resolve(outDir, 'va360-marketplace-public.pem');

  writeFileSync(privatePath, privatePem, { mode: 0o600 });
  writeFileSync(publicPath, publicPem, { mode: 0o644 });

  console.log(`✓ private key  → ${privatePath} (chmod 600)`);
  console.log(`✓ public key   → ${publicPath}`);
  console.log('');
  console.log('Instancia: exporta la pública como env var antes de arrancar el API:');
  console.log('');
  console.log('  export MARKETPLACE_TRUSTED_VENDOR_KEYS_VA360="$(cat ' + publicPath + ')"');
  console.log('');
  console.log('La privada NO debe subirse al repo ni al CI. En producción vive en KMS.');
}

main();
