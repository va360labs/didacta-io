/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * ¿Está bien puesto `TRUSTED_PROXY_HOPS` en un despliegue concreto?
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * `main.ts` declara cuántos proxies PROPIOS hay delante de la API. Ese número
 * decide de dónde sale `request.ip`, y equivocarlo falla en las dos direcciones:
 *
 *   · DEMASIADO ALTO → la API se cree entradas del `X-Forwarded-For` que puso el
 *     cliente. Cualquiera elige la IP que quiere: la suya para saltarse el rate
 *     limit, o la de otro para dejarlo fuera. **Esto sí es una regresión de
 *     seguridad.**
 *   · DEMASIADO BAJO → todo el tráfico anónimo se ve con la IP del proxy y
 *     comparte un único cubo. No es un agujero, pero es el defecto que el parche
 *     venía a arreglar.
 *
 * ── Cómo lo mide ────────────────────────────────────────────────────────────
 *
 * El observable es la cabecera `X-RateLimit-Remaining`, que el interceptor emite
 * SIEMPRE (también en el camino feliz) y cuyo cubo sale del hash de
 * `request.ip`. O sea: el contador es una función directa de lo que `trustProxy`
 * resuelve, sin necesidad de tocar código ni de un endpoint de diagnóstico.
 *
 * ⚠️ NO se usa el log de auditoría como observable, aunque parezca lo natural:
 * hasta LMS-125 registraba el `x-forwarded-for` crudo, así que habría devuelto
 * siempre lo que le mandáramos y la medición habría salido «bien» pasara lo que
 * pasara.
 *
 * Cada prueba lleva su CONTROL al lado. Sin él, un resultado no distingue «el
 * sistema se comporta bien» de «mi sonda no está midiendo nada».
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *
 *   pnpm --filter @didacta/api exec tsx scripts/medir-trusted-proxy.ts \
 *     --url https://aula.ejemplo.com/api/v1/health
 *
 * Conviene un endpoint público, barato y GET. Consume cupo real del rate limit
 * (unas 8 peticiones), así que mejor fuera de hora punta.
 *
 * La prueba de «demasiado bajo» necesita DOS clientes con IP pública distinta y
 * no se puede automatizar desde una sola máquina: el script explica al final
 * cómo hacerla a mano.
 *
 * Exit codes:
 *   0 — la configuración resiste la falsificación
 *   1 — FALSIFICABLE: el XFF del cliente llega a `request.ip`
 *   2 — no se pudo medir (endpoint sin cabeceras de rate limit, red, argumentos)
 */

interface Medicion {
  remaining: number | null;
  limit: number | null;
  status: number;
}

function parseArgs(argv: string[]): { url: string } {
  let url = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') url = argv[++i] ?? '';
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.info('uso: medir-trusted-proxy.ts --url https://host/api/v1/<endpoint-publico>');
      process.exit(0);
    }
  }
  if (!url) {
    console.error('Falta --url. Ejemplo: --url https://aula.ejemplo.com/api/v1/health');
    process.exit(2);
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      console.warn('⚠️  Sin HTTPS la medición vale solo contra localhost.');
    }
  } catch {
    console.error('--url no es una URL válida.');
    process.exit(2);
  }
  return { url };
}

async function sonda(url: string, xff: string | null): Promise<Medicion> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (xff !== null) headers['x-forwarded-for'] = xff;
  const res = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
  const num = (h: string) => {
    const v = res.headers.get(h);
    if (v === null) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    remaining: num('x-ratelimit-remaining'),
    limit: num('x-ratelimit-limit'),
    status: res.status,
  };
}

async function main(): Promise<void> {
  const { url } = parseArgs(process.argv.slice(2));

  // ── Control 0: ¿emite el endpoint las cabeceras que vamos a leer? ─────────
  const cero = await sonda(url, null).catch((err: unknown) => {
    console.error(`No se pudo alcanzar ${url}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  });
  if (cero.remaining === null) {
    console.error(
      'El endpoint no devuelve `X-RateLimit-Remaining`. Sin ese observable no hay medición\n' +
        'posible: elige otro endpoint público, o comprueba que el rate limit esté activo.',
    );
    process.exit(2);
  }
  console.info(`▸ Observable presente. Límite: ${cero.limit}, restantes: ${cero.remaining}`);
  console.info('');

  // ── Control 1: sin cabecera, el contador tiene que BAJAR ─────────────────
  // Si no baja, el cubo no depende de quién llama y ninguna conclusión de abajo
  // sería válida (caché intermedia, rate limit desactivado, endpoint exento).
  const c1 = await sonda(url, null);
  const c2 = await sonda(url, null);
  if (c1.remaining === null || c2.remaining === null || c2.remaining >= c1.remaining) {
    console.error(
      `CONTROL FALLIDO: dos peticiones idénticas no consumen cupo (${c1.remaining} → ${c2.remaining}).\n` +
        'Puede haber una caché delante o el endpoint estar exento. La sonda no mide nada; para.',
    );
    process.exit(2);
  }
  console.info(
    `▸ Control: dos peticiones iguales consumen cupo (${c1.remaining} → ${c2.remaining}). Bien.`,
  );
  console.info('');

  // ── Prueba A: ¿se cree la API el XFF del cliente? ─────────────────────────
  // Direcciones de TEST-NET-3 (RFC 5737): reservadas para documentación, no
  // enrutables, no pueden pertenecer a nadie.
  const falsas = ['203.0.113.11', '203.0.113.22', '203.0.113.33'];
  const lecturas: number[] = [];
  for (const ip of falsas) {
    const m = await sonda(url, ip);
    if (m.remaining === null) {
      console.error('Dejaron de llegar cabeceras a mitad de la prueba. Para.');
      process.exit(2);
    }
    lecturas.push(m.remaining);
    console.info(`  X-Forwarded-For: ${ip.padEnd(14)} → restantes ${m.remaining}`);
  }

  // Si cada IP inventada estrena cubo, los restantes NO descienden entre sí.
  const desciende = lecturas.every((v, i) => i === 0 || v < lecturas[i - 1]!);
  console.info('');

  if (!desciende) {
    console.error('✗ FALSIFICABLE — cada X-Forwarded-For inventado estrena su propio cubo.');
    console.error('');
    console.error('  `request.ip` está saliendo de una entrada que pone el cliente. Con esto');
    console.error('  cualquiera elige su IP: la suya para saltarse el límite, o la de otro para');
    console.error('  dejarlo fuera. Y el rastro de auditoría hereda el mismo problema.');
    console.error('');
    console.error('  Arreglo: BAJA `TRUSTED_PROXY_HOPS` (estás contando más proxies propios de');
    console.error('  los que hay), o mejor declara `TRUSTED_PROXY_IPS` con las IPs/CIDR reales');
    console.error('  de tus proxies — tiene prioridad y no depende de contar bien.');
    process.exit(1);
  }

  console.info('✓ El X-Forwarded-For del cliente NO llega a `request.ip`: el cupo siguió');
  console.info('  descendiendo en el mismo cubo. Por ese lado la configuración resiste.');
  console.info('');
  console.info('Falta la otra mitad, que NO se puede medir desde una sola máquina:');
  console.info('');
  console.info('  ¿Es el número demasiado BAJO? Repite esto desde DOS clientes con IP pública');
  console.info('  distinta (portátil por wifi y móvil por datos), sin cabeceras inventadas:');
  console.info('');
  console.info(`      curl -sD- -o /dev/null ${url} | grep -i x-ratelimit-remaining`);
  console.info('');
  console.info('  Los contadores tienen que ser INDEPENDIENTES. Si comparten cuenta, todo el');
  console.info('  tráfico anónimo está en un solo cubo: sube `TRUSTED_PROXY_HOPS` de uno en uno');
  console.info('  y vuelve a pasar este script — quédate con el MAYOR número que siga sin ser');
  console.info('  falsificable.');
}

void main();
