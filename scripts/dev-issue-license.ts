#!/usr/bin/env tsx
/**
 * dev-issue-license.ts — Issuer mínimo de DESARROLLO.
 *
 * Firma una licencia JWT (ES256) llamando a AWS KMS sobre la key
 * `alias/didacta-issuer-2026` en eu-west-1.
 *
 * NO es el Issuer productivo (ese vive en didacta-cloud/apps/license-issuer/
 * y se construye en Fase 4). Este script es solo para iterar localmente y en
 * tests de integración mientras se desarrolla el SDK.
 *
 * Uso:
 *   pnpm tsx scripts/dev-issue-license.ts \
 *     --org "Universidad Ejemplo" \
 *     --plan enterprise-standard \
 *     --capabilities feat:multi_tenant.real,feat:white_label \
 *     --expires 2027-04-29 \
 *     --out .env.local.license
 *
 * Pre-requisitos:
 *   - AWS CLI configurado con perfil que pueda kms:Sign sobre alias/didacta-issuer-2026.
 *   - Node 22, pnpm 9.
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

interface Args {
  org: string;
  plan: string;
  capabilities: string[];
  expires: string;
  customerId: string;
  organizationId: string;
  out?: string;
  region: string;
  keyAlias: string;
  issuer: string;
  audience: string;
  edition: 'community' | 'enterprise' | 'cloud';
  gracePeriodDays: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string => {
    const ix = argv.findIndex((a) => a === `--${name}`);
    if (ix >= 0 && argv[ix + 1]) return argv[ix + 1]!;
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required arg: --${name}`);
  };

  return {
    org: get('org'),
    plan: get('plan', 'enterprise-standard'),
    capabilities: get('capabilities').split(',').map((c) => c.trim()).filter(Boolean),
    expires: get('expires'),
    customerId: get('customer', `cus_dev_${Date.now()}`),
    organizationId: get('organizationId', `org_dev_${Date.now()}`),
    out: argv.includes('--out') ? get('out') : undefined,
    region: get('region', 'eu-west-1'),
    keyAlias: get('key', 'alias/didacta-issuer-2026'),
    issuer: get('issuer', 'didacta.io'),
    audience: get('audience', 'didacta-runtime'),
    edition: (get('edition', 'enterprise') as Args['edition']),
    gracePeriodDays: Number(get('grace', '30')),
  };
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function awsKmsSign(message: Buffer, region: string, keyAlias: string): Buffer {
  // Llama a AWS KMS Sign. Devuelve la firma en formato DER.
  const messageB64 = message.toString('base64');
  const cmd = [
    'aws',
    'kms',
    'sign',
    '--region', region,
    '--key-id', keyAlias,
    '--message', `fileb://${writeTempFile(messageB64, '.b64')}`,
    '--message-type', 'RAW',
    '--signing-algorithm', 'ECDSA_SHA_256',
    '--query', 'Signature',
    '--output', 'text',
  ];

  // En Windows AWS CLI vive en una ruta concreta. Detectamos.
  const awsExe = detectAwsExe();
  const fullCmd = `"${awsExe}" ${cmd.slice(1).join(' ')}`;

  const output = execSync(fullCmd, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  return Buffer.from(output.trim(), 'base64');
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

function writeTempFile(content: string, ext: string): string {
  // Escribimos el message en un archivo accesible desde Windows (D:/Test/).
  const path = `D:/Test/.kms-sign-input-${Date.now()}${ext}`;
  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * KMS devuelve firmas ECDSA en formato DER. Para JWT necesitamos el formato
 * "raw" (R || S, padded). Convertimos.
 */
function derToRaw(derSig: Buffer): Buffer {
  // ECDSA P-256: R y S de 32 bytes cada uno → raw de 64 bytes total.
  if (derSig[0] !== 0x30) {
    throw new Error('Invalid DER signature: missing SEQUENCE tag');
  }

  let offset = 2; // skip SEQUENCE tag + length
  if ((derSig[1] ?? 0) & 0x80) {
    // long-form length
    offset = 2 + ((derSig[1] ?? 0) & 0x7f);
  }

  // Parse INTEGER R
  if (derSig[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for R');
  const rLen = derSig[offset + 1] ?? 0;
  let r = derSig.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;

  // Parse INTEGER S
  if (derSig[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for S');
  const sLen = derSig[offset + 1] ?? 0;
  let s = derSig.subarray(offset + 2, offset + 2 + sLen);

  // Strip leading 0x00 padding if present
  while (r.length > 32 && r[0] === 0x00) r = r.subarray(1);
  while (s.length > 32 && s[0] === 0x00) s = s.subarray(1);

  // Pad to 32 bytes if shorter
  const rPadded = Buffer.concat([Buffer.alloc(32 - r.length), r]);
  const sPadded = Buffer.concat([Buffer.alloc(32 - s.length), s]);

  return Buffer.concat([rPadded, sPadded]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const now = new Date();
  const expires = new Date(args.expires);
  if (Number.isNaN(expires.getTime())) {
    throw new Error(`Invalid --expires "${args.expires}". Use ISO date YYYY-MM-DD.`);
  }

  const kid = args.keyAlias.replace('alias/', '');

  const header = {
    alg: 'ES256',
    kid,
    typ: 'JWT',
  };

  const payload = {
    iss: args.issuer,
    aud: args.audience,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(expires.getTime() / 1000),
    nbf: Math.floor(now.getTime() / 1000),
    sub: `lic_dev_${Date.now()}`,
    didacta: {
      licenseId: `lic_dev_${Date.now()}`,
      customerId: args.customerId,
      organizationId: args.organizationId,
      organizationName: args.org,
      product: 'didacta',
      plan: args.plan,
      edition: args.edition,
      issuedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      gracePeriodDays: args.gracePeriodDays,
      capabilities: args.capabilities,
    },
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');

  console.log('Signing with AWS KMS...');
  const derSig = awsKmsSign(signingInput, args.region, args.keyAlias);
  const rawSig = derToRaw(derSig);
  const sigB64 = base64UrlEncode(rawSig);

  const jwt = `${headerB64}.${payloadB64}.${sigB64}`;

  console.log(`\nLicense issued for "${args.org}" (plan: ${args.plan}).`);
  console.log(`Capabilities: ${args.capabilities.join(', ') || '(none)'}`);
  console.log(`Expires: ${expires.toISOString()}\n`);
  console.log('JWT:');
  console.log(jwt);

  if (args.out) {
    writeFileSync(args.out, `DIDACTA_LICENSE_KEY=${jwt}\n`, 'utf8');
    console.log(`\nWritten to ${args.out}`);
  }
}

main().catch((err) => {
  console.error('dev-issue-license failed:', err);
  process.exit(1);
});
