import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageAdapter } from '@didacta/core-kernel';

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO requiere true. AWS S3 nativo puede usar false para virtual-hosted-style. */
  forcePathStyle?: boolean;
  /** TTL por defecto para presigned URLs (segundos). Default 900 = 15 min. */
  presignedTtlSeconds?: number;
}

/**
 * Adapter de storage backed por S3-compatible (MinIO en Easypanel, AWS S3, Hetzner, etc.).
 *
 * Por qué presigned URLs: el bucket queda **privado** (sin permisos públicos
 * de lectura). El backend firma una URL temporal con AWS Signature v4 y se la
 * entrega al browser; éste descarga directo del storage sin pasar por la API,
 * pero solo durante la ventana TTL. Esto:
 *   - protege los certificados PDF y blobs sensibles del evidence vault,
 *   - elimina la necesidad de stream-ear desde Node (latencia + RAM),
 *   - sigue funcionando con auth de tenant porque solo el endpoint que
 *     firma valida que el alumno tiene acceso al recurso.
 *
 * Path-style obligatorio en MinIO: la URL queda como
 * `https://lab-minio.../bucket/key` en vez de `https://bucket.lab-minio.../key`.
 */
export class S3StorageService implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly defaultTtl: number;

  constructor(private readonly opts: S3StorageOptions) {
    const config: S3ClientConfig = {
      region: opts.region,
      endpoint: opts.endpoint,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      forcePathStyle: opts.forcePathStyle ?? true,
    };
    this.client = new S3Client(config);
    this.bucket = opts.bucket;
    this.defaultTtl = opts.presignedTtlSeconds ?? 900;
  }

  async upload(
    key: string,
    data: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<{ key: string }> {
    const safe = this.sanitize(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: safe,
        Body: Buffer.isBuffer(data) ? data : Buffer.from(data),
        ContentType: contentType,
      }),
    );
    return { key: safe };
  }

  async download(key: string): Promise<Buffer> {
    const safe = this.sanitize(key);
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safe }));
    if (!out.Body) {
      throw new Error(`S3 GetObject sin Body para ${safe}`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of out.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    const safe = this.sanitize(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safe }));
  }

  async getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    const safe = this.sanitize(key);
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: safe });
    return getSignedUrl(this.client, cmd, {
      expiresIn: expiresInSeconds ?? this.defaultTtl,
    });
  }

  /** Health check: HeadBucket es 200 si el bucket existe y las creds son válidas. */
  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verifica si una key existe (HEAD). Útil para confirmar antes de presignar
   * que el blob aún está en el bucket.
   */
  async exists(key: string): Promise<boolean> {
    const safe = this.sanitize(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safe }));
      return true;
    } catch {
      return false;
    }
  }

  private sanitize(key: string): string {
    if (!key || key.length > 1024) throw new Error('S3 key inválida');
    if (!/^[A-Za-z0-9._\-/]+$/.test(key)) {
      throw new Error('S3 key contiene caracteres no permitidos');
    }
    if (key.includes('..')) throw new Error('S3 key contiene traversal');
    if (key.startsWith('/')) throw new Error('S3 key no debe empezar con /');
    return key;
  }
}

const TRUTHY = new Set(['1', 'true', 'TRUE', 'yes', 'YES']);

/**
 * Construye un S3StorageService desde variables de entorno. Devuelve null si
 * faltan vars críticas (en cuyo caso el caller cae al storage local).
 */
export function buildS3StorageFromEnv(env = process.env): S3StorageService | null {
  const endpoint = env['S3_ENDPOINT'];
  const region = env['S3_REGION'] ?? 'us-east-1';
  const bucket = env['S3_BUCKET'];
  const accessKeyId = env['S3_ACCESS_KEY'] ?? env['S3_ACCESS_KEY_ID'];
  const secretAccessKey = env['S3_SECRET_KEY'] ?? env['S3_SECRET_ACCESS_KEY'];
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }
  const forcePathStyle = TRUTHY.has(env['S3_FORCE_PATH_STYLE'] ?? 'true');
  const presignedTtlSeconds = env['S3_PRESIGNED_TTL_SECONDS']
    ? Number(env['S3_PRESIGNED_TTL_SECONDS'])
    : undefined;
  return new S3StorageService({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle,
    presignedTtlSeconds,
  });
}
