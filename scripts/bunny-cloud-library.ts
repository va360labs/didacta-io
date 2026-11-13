#!/usr/bin/env tsx
/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Revisa (y con --apply, deja) la biblioteca de Bunny Stream de Didacta Cloud
 * como la necesita la subida de vídeo:
 *
 *   - resoluciones 240p–1080p, SIN original, sin MP4 de reserva, sin
 *     reproducción directa;
 *   - embed firmado y token en la CDN;
 *   - webhook apuntando a la API;
 *   - zona de CDN en la red «volumen» y reglas block_original / block_mp4;
 *   - y comprueba que las variables BUNNY_STREAM_* son las de esa biblioteca
 *     (por huella, sin imprimir ninguna clave).
 *
 * Necesita la clave de la CUENTA de Bunny (Account → API key), que NO va al
 * servidor: se pasa solo a este script.
 *
 * Uso (desde la raíz del repo):
 *   BUNNY_ACCOUNT_API_KEY=… pnpm tsx scripts/bunny-cloud-library.ts \
 *     --env C:\Users\valen\.config\didacta\bunny-cloud.env \
 *     --webhook-url https://api.didacta.io/api/v1/video/bunny/webhook [--apply]
 */

import { readFileSync } from 'node:fs';
import {
  BunnyAccountClient,
  planLibrarySetup,
} from '../apps/api/src/video/cloud/bunny-library-setup';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  }
  return out;
}

async function main(): Promise<void> {
  const envPath = arg('--env');
  const webhookUrl = arg('--webhook-url');
  const apply = process.argv.includes('--apply');
  const accountKey = process.env['BUNNY_ACCOUNT_API_KEY'];
  if (!envPath || !webhookUrl || !accountKey) {
    console.error(
      'Falta --env <fichero>, --webhook-url <url> o la variable BUNNY_ACCOUNT_API_KEY.',
    );
    process.exit(2);
  }
  const env = readEnvFile(envPath);
  const libraryId = env['BUNNY_STREAM_LIBRARY_ID'] ?? '';
  const bunny = new BunnyAccountClient(accountKey);
  const library = await bunny.getLibrary(libraryId);
  if (!library.PullZoneId) throw new Error('La biblioteca no tiene zona de CDN asociada.');
  const pullZone = await bunny.getPullZone(library.PullZoneId);
  const plan = planLibrarySetup({
    library,
    pullZone,
    webhookUrl,
    env: {
      apiKey: env['BUNNY_STREAM_API_KEY'] ?? '',
      webhookSecret: env['BUNNY_STREAM_WEBHOOK_SECRET'] ?? '',
      tokenKey: env['BUNNY_STREAM_TOKEN_KEY'] ?? '',
      cdnHostname: env['BUNNY_STREAM_CDN_HOSTNAME'] ?? '',
    },
  });

  console.log(`Biblioteca ${libraryId} · zona de CDN ${library.PullZoneId}`);
  for (const c of plan.checks) console.log(`  ${c.ok ? 'OK ' : 'MAL'} ${c.name} (${c.detail})`);
  console.log(`Cambios en la biblioteca: ${JSON.stringify(plan.library)}`);
  console.log(`Cambios en la zona de CDN: ${JSON.stringify(plan.pullZone)}`);
  console.log(
    `Reglas que faltan: ${plan.edgeRules.map((r) => r['Description']).join(', ') || 'ninguna'}`,
  );

  if (!apply) {
    console.log('\nSolo revisión. Repite con --apply para aplicar los cambios.');
    return;
  }
  if (Object.keys(plan.library).length > 0) await bunny.updateLibrary(libraryId, plan.library);
  if (Object.keys(plan.pullZone).length > 0) {
    await bunny.updatePullZone(library.PullZoneId, plan.pullZone);
  }
  for (const rule of plan.edgeRules) await bunny.addEdgeRule(library.PullZoneId, rule);
  console.log('\nAplicado. Vuelve a ejecutarlo sin --apply para comprobar que no queda nada.');
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
