#!/usr/bin/env -S node --import tsx
/* eslint-disable no-console */

/// Empaqueta y firma un módulo `*.zip` para distribución oficial
/// (vendor=didacta). Reusa el mismo flujo de firma que el license-issuer:
/// AWS KMS `kms:Sign` sobre `alias/didacta-issuer-2026` (eu-west-1, ECDSA
/// P-256 + SHA-256), produciendo un JWT compact ES256.
///
/// Este script vive en el repo solo como helper para el operador Didacta
/// (release manager). En Fase 4 lo absorbe el pipeline CI del
/// `apps/license-issuer` (didacta-cloud) cuando publique módulos junto a
/// las licencias.
///
/// Uso:
///   pnpm tsx scripts/marketplace/sign-package.ts \
///     --manifest ./build/mod.example/manifest.json \
///     --dist ./build/mod.example/dist \
///     --migrations ./build/mod.example/prisma/migrations \
///     --out ./dist/mod.example-1.0.0.zip \
///     --kid didacta-issuer-2026
///
/// Pre-requisitos:
///   - AWS CLI v2 configurado con perfil que pueda kms:Sign sobre
///     alias/didacta-issuer-2026.
///   - Node 22, pnpm 9.

import AdmZip from 'adm-zip';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface Args {
  manifestPath: string;
  distDir: string;
  migrationsDir?: string;
  packageJsonPath?: string;
  out: string;
  kid: string;
  region: string;
  keyAlias: string;
  issuer: string;
  audience: string;
  /// URL del `apps/license-issuer` cuando queremos firmar via API en
  /// lugar de invocar AWS CLI local. Modo recomendado en producción
  /// (ver didacta-cloud/docs/MARKETPLACE-CI-SIGNING.md): solo el
  /// service tiene `kms:Sign`; los release managers le hablan via
  /// HTTPS con un Bearer token.
  remoteIssuer?: string;
  remoteIssuerToken?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string => {
    const ix = argv.findIndex((a) => a === `--${name}`);
    if (ix >= 0 && argv[ix + 1]) return argv[ix + 1]!;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required arg: --${name}`);
  };

  return {
    manifestPath: get('manifest'),
    distDir: get('dist'),
    migrationsDir: argv.includes('--migrations') ? get('migrations') : undefined,
    packageJsonPath: argv.includes('--package-json') ? get('package-json') : undefined,
    out: get('out'),
    kid: get('kid', 'didacta-issuer-2026'),
    region: get('region', 'eu-west-1'),
    keyAlias: get('key', 'alias/didacta-issuer-2026'),
    issuer: get('issuer', 'didacta.io'),
    audience: get('audience', 'didacta-marketplace'),
    remoteIssuer: argv.includes('--remote-issuer')
      ? get('remote-issuer')
      : process.env['LICENSE_ISSUER_URL'],
    remoteIssuerToken: argv.includes('--remote-issuer-token')
      ? get('remote-issuer-token')
      : process.env['LICENSE_ISSUER_BEARER_TOKEN'],
  };
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function detectAwsExe(): string {
  const candidates = [
    'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
    '/usr/local/bin/aws',
    '/usr/bin/aws',
    'aws',
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: 'ignore' });
      return c;
    } catch {
      // try next
    }
  }
  throw new Error('AWS CLI not found. Install AWS CLI v2 first.');
}

function awsKmsSign(message: Buffer, region: string, keyAlias: string): Buffer {
  // Escribimos el message como bytes RAW (NO base64) y lo pasamos con
  // `fileb://`. fileb:// instruye a aws-cli a leer el archivo como
  // binario sin decodificar — eso es exactamente lo que necesita KMS
  // con `--message-type RAW`.
  //
  // BUG previo (alpha.29 inicial): se escribía `message.toString('base64')`
  // al archivo, así que KMS firmaba los bytes ASCII de la string base64
  // en lugar del message original. Resultado: el JWT producido tenía
  // firma sobre `base64(header.payload)` y los verifiers (que firman
  // `header.payload` directamente) fallaban con
  // "signature verification failed".
  const tmp = resolve(process.cwd(), `.kms-sign-input-${Date.now()}.bin`);
  writeFileSync(tmp, message);
  const awsExe = detectAwsExe();
  const cmd = [
    'kms',
    'sign',
    '--region',
    region,
    '--key-id',
    keyAlias,
    '--message',
    `fileb://${tmp}`,
    '--message-type',
    'RAW',
    '--signing-algorithm',
    'ECDSA_SHA_256',
    '--query',
    'Signature',
    '--output',
    'text',
  ];
  const fullCmd = `"${awsExe}" ${cmd.join(' ')}`;
  const output = execSync(fullCmd, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  return Buffer.from(output.trim(), 'base64');
}

/// KMS devuelve firmas ECDSA en formato DER. Para JWT necesitamos el
/// formato "raw" R||S de 64 bytes total. Misma lógica que
/// `scripts/dev-issue-license.ts`.
function derToRaw(derSig: Buffer): Buffer {
  if (derSig[0] !== 0x30) throw new Error('Invalid DER signature: missing SEQUENCE tag');
  let offset = 2;
  if ((derSig[1] ?? 0) & 0x80) offset = 2 + ((derSig[1] ?? 0) & 0x7f);

  if (derSig[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for R');
  const rLen = derSig[offset + 1] ?? 0;
  let r = derSig.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;

  if (derSig[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for S');
  const sLen = derSig[offset + 1] ?? 0;
  let s = derSig.subarray(offset + 2, offset + 2 + sLen);

  // Strip leading zero (DER positive-integer padding) y pad a 32 bytes.
  if (r.length === 33 && r[0] === 0) r = r.subarray(1);
  if (s.length === 33 && s[0] === 0) s = s.subarray(1);
  const rPadded = Buffer.concat([Buffer.alloc(32 - r.length), r]);
  const sPadded = Buffer.concat([Buffer.alloc(32 - s.length), s]);
  return Buffer.concat([rPadded, sPadded]);
}

async function buildJwt(payload: Record<string, unknown>, args: Args): Promise<string> {
  // Modo `--remote-issuer`: pide al license-issuer (didacta-cloud) que
  // firme el manifest. Es el modo correcto en producción (ver
  // `didacta-cloud/docs/MARKETPLACE-CI-SIGNING.md`). El runner CI no
  // necesita credenciales AWS — el license-issuer es el único con
  // `kms:Sign` y nos devuelve el JWT ya armado.
  if (args.remoteIssuer) {
    if (!args.remoteIssuerToken) {
      throw new Error(
        '--remote-issuer requiere --remote-issuer-token o env LICENSE_ISSUER_BEARER_TOKEN.',
      );
    }
    return buildJwtRemote(payload, args.remoteIssuer, args.remoteIssuerToken);
  }

  // Modo legacy/dev: AWS CLI local. Requiere `kms:Sign` en el user
  // configurado, lo cual hoy NO recomendamos a release managers
  // (ver opción C en MARKETPLACE-CI-SIGNING.md). Útil para pruebas
  // locales si ya tienes el rol asumido.
  const header = { alg: 'ES256', kid: args.kid, typ: 'JWT' };
  const fullPayload = {
    iss: args.issuer,
    aud: args.audience,
    iat: Math.floor(Date.now() / 1000),
    ...payload,
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const derSig = awsKmsSign(Buffer.from(signingInput, 'utf8'), args.region, args.keyAlias);
  const rawSig = derToRaw(derSig);
  return `${signingInput}.${base64UrlEncode(rawSig)}`;
}

async function buildJwtRemote(
  manifest: Record<string, unknown>,
  issuerUrl: string,
  bearer: string,
): Promise<string> {
  const url = `${issuerUrl.replace(/\/$/, '')}/v1/modules/sign-manifest`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ manifest }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`license-issuer respondió ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { manifest_jwt?: string };
  if (!data.manifest_jwt) {
    throw new Error('license-issuer devolvió respuesta sin manifest_jwt');
  }
  return data.manifest_jwt;
}

function addDirToZip(zip: AdmZip, srcDir: string, zipPrefix: string): void {
  if (!existsSync(srcDir)) return;
  for (const entry of readdirSync(srcDir)) {
    const fullPath = join(srcDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      addDirToZip(zip, fullPath, `${zipPrefix}${entry}/`);
    } else {
      zip.addFile(`${zipPrefix}${entry}`, readFileSync(fullPath));
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(args.manifestPath, 'utf8')) as Record<string, unknown>;

  if (manifest['vendor'] !== 'didacta') {
    throw new Error(
      `manifest.vendor debe ser 'didacta' para firmar con KMS de Didacta. Recibido: ${String(manifest['vendor'])}`,
    );
  }

  // El JWT lleva el manifest entero como payload.
  const jwt = await buildJwt(manifest, args);

  const zip = new AdmZip();
  zip.addFile('manifest.jwt', Buffer.from(jwt, 'utf8'));

  // package.json: opcional override; sino, derivamos minimal del manifest.
  if (args.packageJsonPath) {
    zip.addFile('package.json', readFileSync(args.packageJsonPath));
  } else {
    zip.addFile(
      'package.json',
      Buffer.from(
        JSON.stringify(
          {
            name: manifest['name'],
            version: manifest['version'],
            main: 'dist/index.js',
          },
          null,
          2,
        ),
        'utf8',
      ),
    );
  }

  addDirToZip(zip, args.distDir, 'dist/');
  if (args.migrationsDir) {
    addDirToZip(zip, args.migrationsDir, 'prisma/migrations/');
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, zip.toBuffer());

  console.log(`✓ Paquete firmado: ${args.out}`);
  console.log(`  vendor:   ${manifest['vendor']}`);
  console.log(`  name:     ${manifest['name']}`);
  console.log(`  version:  ${manifest['version']}`);
  console.log(`  kid:      ${args.kid}`);
  console.log(`  audience: ${args.audience}`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
