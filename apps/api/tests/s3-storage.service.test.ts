import { Readable } from 'node:stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { S3StorageService, buildS3StorageFromEnv } from '../src/modules/s3-storage.service';

const sendMock = vi.fn();
vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn(() => ({
      send: sendMock,
    })),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example.com/blob?expires=900'),
}));

const VALID_OPTS = {
  endpoint: 'https://lab-minio.example.com',
  region: 'us-east-1',
  bucket: 'didacta',
  accessKeyId: 'admin',
  secretAccessKey: 'pass',
};

describe('S3StorageService', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  describe('upload', () => {
    it('usa PutObjectCommand con bucket+key+body', async () => {
      sendMock.mockResolvedValue({});
      const svc = new S3StorageService(VALID_OPTS);
      const out = await svc.upload('certs/2026/abc.pdf', Buffer.from('hola'), 'application/pdf');
      expect(out.key).toBe('certs/2026/abc.pdf');
      expect(sendMock).toHaveBeenCalledOnce();
      const cmd = sendMock.mock.calls[0]![0];
      expect(cmd.input.Bucket).toBe('didacta');
      expect(cmd.input.Key).toBe('certs/2026/abc.pdf');
      expect(cmd.input.ContentType).toBe('application/pdf');
    });

    it('rechaza keys con traversal', async () => {
      const svc = new S3StorageService(VALID_OPTS);
      await expect(svc.upload('../etc/passwd', Buffer.from(''))).rejects.toThrow();
    });

    it('rechaza keys con caracteres no permitidos', async () => {
      const svc = new S3StorageService(VALID_OPTS);
      await expect(svc.upload('a b/c', Buffer.from(''))).rejects.toThrow();
    });

    it('rechaza keys que empiezan con /', async () => {
      const svc = new S3StorageService(VALID_OPTS);
      await expect(svc.upload('/abs/path', Buffer.from(''))).rejects.toThrow();
    });
  });

  describe('download', () => {
    it('lee el Body como stream y devuelve Buffer concatenado', async () => {
      const stream = Readable.from([Buffer.from('hola '), Buffer.from('mundo')]);
      sendMock.mockResolvedValue({ Body: stream });
      const svc = new S3StorageService(VALID_OPTS);
      const buf = await svc.download('a/b.bin');
      expect(buf.toString()).toBe('hola mundo');
    });

    it('lanza si la response no trae Body', async () => {
      sendMock.mockResolvedValue({ Body: null });
      const svc = new S3StorageService(VALID_OPTS);
      await expect(svc.download('a/b.bin')).rejects.toThrow(/sin Body/);
    });
  });

  describe('delete', () => {
    it('llama DeleteObjectCommand', async () => {
      sendMock.mockResolvedValue({});
      const svc = new S3StorageService(VALID_OPTS);
      await svc.delete('a/b.bin');
      const cmd = sendMock.mock.calls[0]![0];
      expect(cmd.input.Key).toBe('a/b.bin');
    });
  });

  describe('getSignedUrl', () => {
    it('usa getSignedUrl del request-presigner con TTL default 900s', async () => {
      const presigner = await import('@aws-sdk/s3-request-presigner');
      const svc = new S3StorageService(VALID_OPTS);
      const url = await svc.getSignedUrl('a/b.bin');
      expect(url).toContain('signed.example.com');
      const lastCall = (
        presigner.getSignedUrl as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)!;
      expect(lastCall[2]).toEqual({ expiresIn: 900 });
    });

    it('TTL custom respetado', async () => {
      const presigner = await import('@aws-sdk/s3-request-presigner');
      const svc = new S3StorageService({ ...VALID_OPTS, presignedTtlSeconds: 300 });
      await svc.getSignedUrl('a/b.bin', 60);
      const lastCall = (
        presigner.getSignedUrl as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)!;
      expect(lastCall[2]).toEqual({ expiresIn: 60 });
    });

    it('TTL del constructor se usa cuando no se pasa override', async () => {
      const presigner = await import('@aws-sdk/s3-request-presigner');
      const svc = new S3StorageService({ ...VALID_OPTS, presignedTtlSeconds: 600 });
      await svc.getSignedUrl('a/b.bin');
      const lastCall = (
        presigner.getSignedUrl as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)!;
      expect(lastCall[2]).toEqual({ expiresIn: 600 });
    });
  });

  describe('ping/exists', () => {
    it('ping=true cuando HeadBucket no lanza', async () => {
      sendMock.mockResolvedValue({});
      const svc = new S3StorageService(VALID_OPTS);
      expect(await svc.ping()).toBe(true);
    });
    it('ping=false cuando HeadBucket lanza', async () => {
      sendMock.mockRejectedValue(new Error('credentials invalid'));
      const svc = new S3StorageService(VALID_OPTS);
      expect(await svc.ping()).toBe(false);
    });
    it('exists=true cuando HEAD responde', async () => {
      sendMock.mockResolvedValue({});
      const svc = new S3StorageService(VALID_OPTS);
      expect(await svc.exists('a.bin')).toBe(true);
    });
    it('exists=false en NotFound', async () => {
      sendMock.mockRejectedValue(new Error('NotFound'));
      const svc = new S3StorageService(VALID_OPTS);
      expect(await svc.exists('a.bin')).toBe(false);
    });
  });
});

describe('buildS3StorageFromEnv', () => {
  it('null cuando faltan vars críticas', () => {
    expect(buildS3StorageFromEnv({ S3_ENDPOINT: 'x' })).toBeNull();
    expect(buildS3StorageFromEnv({})).toBeNull();
  });

  it('construye con todas las vars', () => {
    const svc = buildS3StorageFromEnv({
      S3_ENDPOINT: 'https://m.x.com',
      S3_REGION: 'eu-west-1',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY: 'k',
      S3_SECRET_KEY: 's',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PRESIGNED_TTL_SECONDS: '300',
    });
    expect(svc).not.toBeNull();
  });

  it('acepta también S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (alternativos AWS)', () => {
    const svc = buildS3StorageFromEnv({
      S3_ENDPOINT: 'x',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    });
    expect(svc).not.toBeNull();
  });
});
