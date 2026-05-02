import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importSPKI, jwtVerify, type JWTPayload, type KeyLike } from 'jose';
import { moduleManifestSchema, type ModuleManifest } from './module-manifest.schema';
import { MarketplacePackageError } from './module-package.errors';

/// Verifica firmas JWS (ES256) de los manifests de paquetes `*.zip`.
///
/// **Mismo esquema que el License SDK**: ECDSA P-256 + SHA-256, JWT compact,
/// firmado por AWS KMS `alias/didacta-issuer-2026` (eu-west-1). La
/// distinción entre licencias y módulos viaja en el claim `aud`:
///
///   - License SDK:     `iss=didacta.io`, `aud=didacta-runtime`
///   - Marketplace:     `iss=didacta.io`, `aud=didacta-marketplace`
///
/// Las claves públicas viven en disco bajo `MARKETPLACE_PUBLIC_KEYS_DIR`
/// (default: la misma carpeta que `license-sdk/src/public-keys/`). Cada
/// archivo `<kid>.pem` se carga al primer uso. Sin env vars con claves —
/// las claves públicas no son secretos y se versionan en el repo.
///
/// Tests: registramos claves efímeras vía `registerPublicKeyForTest()`
/// para no depender de KMS real.

export const MARKETPLACE_ISSUER = 'didacta.io';
export const MARKETPLACE_AUDIENCE = 'didacta-marketplace';
const ALG = 'ES256';

/// Path por defecto de las claves públicas. Reusa el directorio del
/// license-sdk porque la KMS key es la misma en MVP. Si en el futuro se
/// crea un alias separado (`didacta-marketplace-2026`), este path puede
/// apuntar a un directorio dedicado vía `MARKETPLACE_PUBLIC_KEYS_DIR`.
///
/// El cwd del proceso depende de cómo se arranca: en `pnpm dev` desde
/// la raíz del monorepo es `/repo`; en producción `node dist/main.js`
/// desde `apps/api/` es `/repo/apps/api`. Buscamos el dir de claves
/// subiendo niveles desde el cwd hasta encontrarlo. Sin esto, el
/// contenedor de producción reportaba `Unknown kid` aunque el .pem
/// existiera dos directorios arriba.
function defaultPublicKeysDir(): string {
  // Probamos pares (cwd-relative) × (path en repo). Producción tiene los
  // .pem en `packages/license-sdk/public-keys/` (rescatados antes del
  // pruner, ver Dockerfile). Dev mantiene la carpeta original
  // `packages/license-sdk/src/public-keys/`.
  const subPaths = [
    'packages/license-sdk/public-keys',
    'packages/license-sdk/src/public-keys',
  ];
  const cwdPrefixes = ['', '../', '../../', '../../../'];
  for (const prefix of cwdPrefixes) {
    for (const sub of subPaths) {
      const candidate = resolve(process.cwd(), prefix + sub);
      if (existsSync(candidate)) return candidate;
    }
  }
  return resolve(process.cwd(), subPaths[0]!);
}

@Injectable()
export class ModuleSignatureService {
  private readonly logger = new Logger(ModuleSignatureService.name);
  private publicKeysCache: Map<string, Promise<KeyLike>> | null = null;

  onModuleInit(): void {
    // Lazy: cargamos al primer verify para que el servicio arranque incluso
    // si el directorio aún no está poblado en algunos deploys (ej. tests
    // que registran clave efímera).
    this.publicKeysCache = null;
  }

  /// **Solo tests**: registra una clave pública con un `kid` arbitrario en
  /// la cache. Permite firmar fixtures con un par efímero sin depender de
  /// KMS real. Equivalente al `registerPublicKeyForTest` del license-sdk.
  registerPublicKeyForTest(kid: string, key: KeyLike): void {
    if (!this.publicKeysCache) this.publicKeysCache = new Map();
    this.publicKeysCache.set(kid, Promise.resolve(key));
  }

  /// **Solo tests**: limpia la cache de claves públicas para que el
  /// próximo verify recargue desde disco. Usado en tests que mutan
  /// `MARKETPLACE_PUBLIC_KEYS_DIR`.
  resetPublicKeysCacheForTest(): void {
    this.publicKeysCache = null;
  }

  /// Verifica un `manifest.jwt` (JWS compact ES256). Devuelve el manifest
  /// parseado y validado contra el schema Zod, listo para usar.
  ///
  /// Errores:
  ///   - `SIGNATURE_INVALID` — JWT malformado o algoritmo no soportado.
  ///   - `SIGNATURE_VERIFY_FAILED` — firma inválida, kid desconocido,
  ///     issuer/audience incorrectos, expiración (si el JWT trae `exp`).
  ///   - `MANIFEST_SCHEMA_INVALID` — el payload no cumple el schema.
  async verifyManifestJwt(token: string): Promise<ModuleManifest> {
    if (!token || typeof token !== 'string' || !token.includes('.')) {
      throw new MarketplacePackageError(
        'SIGNATURE_INVALID',
        'manifest.jwt no es un JWT válido (formato compact esperado).',
      );
    }

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, async (header) => this.resolveKey(header.kid), {
        algorithms: [ALG],
        issuer: MARKETPLACE_ISSUER,
        audience: MARKETPLACE_AUDIENCE,
      });
      payload = result.payload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MarketplacePackageError(
        'SIGNATURE_VERIFY_FAILED',
        `No se pudo verificar la firma del manifest: ${msg}`,
      );
    }

    // El payload del JWT ES el manifest. Quitamos los claims estándar
    // (iss/aud/iat/exp/nbf/sub/jti) antes de parsear contra el schema
    // del módulo, que es estricto (`.strict()`).
    const stripped = stripJwtClaims(payload);
    const parsed = moduleManifestSchema.safeParse(stripped);
    if (!parsed.success) {
      throw new MarketplacePackageError(
        'MANIFEST_SCHEMA_INVALID',
        'El payload del manifest.jwt no cumple el schema del contrato de módulo.',
        { issues: parsed.error.issues },
      );
    }

    // Defensa adicional: el vendor declarado en el manifest debe coincidir
    // con un vendor confiado por la instancia. Hoy solo `didacta`.
    if (parsed.data.vendor !== 'didacta') {
      throw new MarketplacePackageError(
        'VENDOR_NOT_TRUSTED',
        `Vendor "${parsed.data.vendor}" no es de confianza para esta instancia. Solo "didacta" en MVP.`,
        { vendor: parsed.data.vendor },
      );
    }

    return parsed.data;
  }

  private async resolveKey(kid: string | undefined): Promise<KeyLike> {
    if (!kid) {
      throw new MarketplacePackageError(
        'SIGNATURE_VERIFY_FAILED',
        'manifest.jwt sin `kid` en el header. Reusa la KMS key del license-sdk.',
      );
    }
    if (!this.publicKeysCache) {
      this.publicKeysCache = this.loadPublicKeysFromDisk();
    }
    const cached = this.publicKeysCache.get(kid);
    if (!cached) {
      throw new MarketplacePackageError(
        'SIGNATURE_VERIFY_FAILED',
        `Unknown kid "${kid}". La clave pública no está embebida en este build.`,
        { kid },
      );
    }
    return cached;
  }

  private loadPublicKeysFromDisk(): Map<string, Promise<KeyLike>> {
    const dir = process.env['MARKETPLACE_PUBLIC_KEYS_DIR'] ?? defaultPublicKeysDir();
    const map = new Map<string, Promise<KeyLike>>();
    if (!existsSync(dir)) {
      this.logger.warn(
        `Directorio de claves públicas del marketplace no existe: ${dir}. ` +
          `Cualquier verify fallará con SIGNATURE_VERIFY_FAILED hasta que se publique al menos una clave.`,
      );
      return map;
    }
    const files = readdirSync(dir).filter((f) => f.endsWith('.pem'));
    for (const filename of files) {
      const kid = filename.replace(/\.pem$/, '');
      const pem = readFileSync(join(dir, filename), 'utf8');
      map.set(kid, importSPKI(pem, ALG));
    }
    if (map.size === 0) {
      this.logger.warn(`Sin claves públicas en ${dir} — el marketplace no aceptará paquetes.`);
    } else {
      this.logger.log(`Marketplace: cargadas ${map.size} clave(s) pública(s) desde ${dir}.`);
    }
    return map;
  }
}

const JWT_RESERVED_CLAIMS = new Set(['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti']);

function stripJwtClaims(payload: JWTPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (JWT_RESERVED_CLAIMS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
