#!/usr/bin/env node
/*
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * audit-report-verify — validador offline de paquetes de auditoría firmados
 * (quinto piloto License SDK · feat:reports.advanced_signed).
 *
 * Recibe la ruta a un ZIP generado por GET /audit/entries.zip y verifica:
 *
 *   1. Que existen los 3 artefactos esperados (manifest.json,
 *      audit-entries.ndjson, signature.json).
 *   2. Que los SHA-256 declarados en manifest.artefactos coinciden con el
 *      contenido real de cada archivo.
 *   3. Que la firma HMAC-SHA256 del manifest declarada en signature.json
 *      coincide con el cálculo local usando la clave HMAC derivada
 *      (HMAC-SHA256(masterKey, tenantId)).
 *
 * Uso:
 *   node tools/audit-report-verify.mjs <ruta-al-zip> \
 *     [--key <masterKey>]
 *
 * Si no se pasa `--key`, usa `AUDIT_REPORT_HMAC_KEY` del entorno o el fallback
 * interno (mismo que el service, sólo válido para tests/dev).
 *
 * Exit:
 *   0 → ZIP íntegro, hashes y firma válidos.
 *   1 → Discrepancia (hash, firma, archivo faltante o malformado).
 *   2 → Error de uso (path inexistente, flags inválidos).
 *
 * Limitación criptográfica: la firma es HMAC-SHA256 (clave compartida). En
 * producción esto se reemplaza por una firma asimétrica X.509 (RSA o ECDSA).
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import AdmZip from 'adm-zip';

const MANIFEST_FILENAME = 'manifest.json';
const ENTRIES_FILENAME = 'audit-entries.ndjson';
const SIGNATURE_FILENAME = 'signature.json';
const FALLBACK_KEY = 'didacta-audit-report-hmac-fallback-do-not-use-in-prod';
const EXPECTED_VERSION = 'v1-audit-signed';
const EXPECTED_ALG = 'HMAC-SHA256';

function parseArgs(argv) {
  const args = { zipPath: null, masterKey: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key') {
      args.masterKey = argv[++i] ?? null;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      positional.push(a);
    }
  }
  args.zipPath = positional[0] ?? null;
  return args;
}

function printUsageAndExit(code) {
  const usage = [
    'Uso: node tools/audit-report-verify.mjs <ruta-al-zip> [--key <masterKey>]',
    '',
    'Exit codes:',
    '  0 → ZIP íntegro.',
    '  1 → Discrepancia (hash o firma).',
    '  2 → Error de uso.',
  ].join('\n');
  process.stderr.write(usage + '\n');
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`[FAIL] ${message}\n`);
  process.exit(1);
}

function ok(message) {
  process.stdout.write(`[OK] ${message}\n`);
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function deriveTenantHmacKey(masterKey, tenantId) {
  return createHmac('sha256', masterKey).update(tenantId).digest();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.zipPath) {
    printUsageAndExit(args.help ? 0 : 2);
    return;
  }

  const zipPath = resolve(args.zipPath);
  if (!existsSync(zipPath)) {
    process.stderr.write(`[ERR] No existe el archivo: ${zipPath}\n`);
    process.exit(2);
  }

  const masterKey = args.masterKey ?? process.env.AUDIT_REPORT_HMAC_KEY ?? FALLBACK_KEY;

  let zip;
  try {
    zip = new AdmZip(readFileSync(zipPath));
  } catch (err) {
    fail(`No se pudo abrir el ZIP: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 1. Verificar presencia de los 3 artefactos.
  const names = new Set(zip.getEntries().map((e) => e.entryName));
  for (const required of [MANIFEST_FILENAME, ENTRIES_FILENAME, SIGNATURE_FILENAME]) {
    if (!names.has(required)) {
      fail(`Archivo requerido ausente del ZIP: ${required}`);
      return;
    }
  }
  ok('Estructura del ZIP correcta (manifest + entries + signature).');

  // 2. Manifest parseable y con shape esperada.
  const manifestBuf = zip.readFile(MANIFEST_FILENAME);
  const entriesBuf = zip.readFile(ENTRIES_FILENAME);
  const signatureBuf = zip.readFile(SIGNATURE_FILENAME);
  if (!manifestBuf || !entriesBuf || !signatureBuf) {
    fail('Lectura de uno de los artefactos devolvió null.');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch (err) {
    fail(`manifest.json no es JSON válido: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (manifest.version !== EXPECTED_VERSION) {
    fail(`version del manifest inesperada: "${manifest.version}" (esperado "${EXPECTED_VERSION}")`);
    return;
  }
  if (manifest.signatureAlgorithm !== EXPECTED_ALG) {
    fail(
      `signatureAlgorithm inesperado: "${manifest.signatureAlgorithm}" (esperado "${EXPECTED_ALG}")`,
    );
    return;
  }
  if (typeof manifest.tenantId !== 'string' || manifest.tenantId.length === 0) {
    fail('manifest.tenantId ausente o vacío.');
    return;
  }
  if (!Array.isArray(manifest.artefactos)) {
    fail('manifest.artefactos no es un array.');
    return;
  }

  // 3. SHA-256 de cada artefacto declarado en manifest.
  for (const artefacto of manifest.artefactos) {
    const buf = zip.readFile(artefacto.name);
    if (!buf) {
      fail(`manifest declara un artefacto ausente del ZIP: ${artefacto.name}`);
      return;
    }
    const actualSha = sha256Hex(buf);
    if (actualSha !== artefacto.sha256) {
      fail(
        `SHA-256 mismatch en ${artefacto.name}: declarado=${artefacto.sha256}, real=${actualSha}`,
      );
      return;
    }
    if (typeof artefacto.size === 'number' && artefacto.size !== buf.length) {
      fail(`Size mismatch en ${artefacto.name}: declarado=${artefacto.size}, real=${buf.length}`);
      return;
    }
  }
  ok(`SHA-256 de ${manifest.artefactos.length} artefacto(s) coinciden.`);

  // 4. Firma HMAC del manifest.
  let signature;
  try {
    signature = JSON.parse(signatureBuf.toString('utf8'));
  } catch (err) {
    fail(`signature.json no es JSON válido: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (signature.algorithm !== EXPECTED_ALG) {
    fail(`signature.algorithm inesperado: "${signature.algorithm}"`);
    return;
  }
  const expectedManifestSha = sha256Hex(manifestBuf);
  if (signature.manifestSha256 !== expectedManifestSha) {
    fail(
      `signature.manifestSha256 no coincide con SHA-256 del manifest real: ` +
        `declarado=${signature.manifestSha256}, real=${expectedManifestSha}`,
    );
    return;
  }
  const tenantKey = deriveTenantHmacKey(masterKey, manifest.tenantId);
  const expectedHmac = createHmac('sha256', tenantKey).update(manifestBuf).digest('hex');
  if (signature.signatureHmacSha256 !== expectedHmac) {
    fail(
      `Firma HMAC-SHA256 NO coincide. Posible tampering del manifest o clave HMAC ` +
        `incorrecta. Si la masterKey real difiere de la usada (default fallback), ` +
        `pasa --key <masterKey> al validador.`,
    );
    return;
  }
  ok('Firma HMAC-SHA256 del manifest válida.');

  // 5. Sanidad: el conteo del manifest coincide con líneas del NDJSON.
  const ndjson = entriesBuf.toString('utf8');
  const lineCount =
    ndjson.length === 0
      ? 0
      : ndjson.endsWith('\n')
        ? ndjson.slice(0, -1).split('\n').length
        : ndjson.split('\n').length;
  if (lineCount !== manifest.entryCount) {
    fail(
      `entryCount del manifest (${manifest.entryCount}) no coincide con líneas del NDJSON (${lineCount}).`,
    );
    return;
  }
  ok(`entryCount coincide (${manifest.entryCount} entry/ies).`);

  process.stdout.write(
    `[VERIFY-OK] tenant=${manifest.tenantId} entries=${manifest.entryCount} ` +
      `range=${manifest.range.from ?? 'null'}..${manifest.range.to ?? 'null'} ` +
      `generatedAt=${manifest.generatedAt}\n`,
  );
  process.exit(0);
}

main();
