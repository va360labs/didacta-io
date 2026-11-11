import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpAdapterService } from '../src/modules/smtp-adapter.service';

const sendMailMock = vi.fn();
const verifyMock = vi.fn();
const closeMock = vi.fn();

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: sendMailMock,
      verify: verifyMock,
      close: closeMock,
    })),
  },
}));

const VALID = {
  host: 'smtp.example.com',
  port: 587,
  user: 'foo',
  password: 'p4ss',
  from: 'noreply@example.com',
};

describe('SmtpAdapterService', () => {
  let svc: SmtpAdapterService;

  beforeEach(() => {
    sendMailMock.mockReset();
    verifyMock.mockReset();
    closeMock.mockReset();
    svc = new SmtpAdapterService();
  });

  describe('parseConfig', () => {
    it('acepta config válida', () => {
      expect(svc.parseConfig(VALID)).toMatchObject({ host: 'smtp.example.com', port: 587 });
    });

    it('rechaza puerto fuera de rango', () => {
      expect(() => svc.parseConfig({ ...VALID, port: 99999 })).toThrow();
    });

    it('rechaza from no email', () => {
      expect(() => svc.parseConfig({ ...VALID, from: 'no-es-email' })).toThrow();
    });

    it('rechaza host vacío', () => {
      expect(() => svc.parseConfig({ ...VALID, host: '' })).toThrow();
    });
  });

  describe('isConfigValid', () => {
    it('true con config completa', () => {
      expect(svc.isConfigValid(VALID)).toBe(true);
    });
    it('false con config incompleta', () => {
      expect(svc.isConfigValid({ host: 'x' })).toBe(false);
    });
    it('false con valor undefined', () => {
      expect(svc.isConfigValid(undefined)).toBe(false);
    });
  });

  describe('send', () => {
    it('llama transporter.sendMail con los params correctos', async () => {
      sendMailMock.mockResolvedValue({ messageId: '<abc@x>' });
      const result = await svc.send(svc.parseConfig(VALID), {
        to: 'a@b.com',
        subject: 'hola',
        text: 'cuerpo',
      });
      expect(result.ok).toBe(true);
      expect(result.messageId).toBe('<abc@x>');
      expect(sendMailMock).toHaveBeenCalledWith({
        from: VALID.from,
        to: 'a@b.com',
        subject: 'hola',
        text: 'cuerpo',
        html: undefined,
      });
      expect(closeMock).toHaveBeenCalled();
    });

    it('con enlace de baja añade List-Unsubscribe y List-Unsubscribe-Post (RFC 8058)', async () => {
      sendMailMock.mockResolvedValue({ messageId: '<abc@x>' });
      const unsubscribeUrl =
        'https://aula.example.test/api/v1/modules/community/unsubscribe?token=t';
      await svc.send(svc.parseConfig(VALID), {
        to: 'a@b.com',
        subject: 'resumen',
        text: 'cuerpo',
        unsubscribeUrl,
      });
      expect(sendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          // nodemailer convierte `list.unsubscribe` en `List-Unsubscribe: <url>`.
          list: { unsubscribe: unsubscribeUrl },
          headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        }),
      );
    });

    it('sin enlace de baja NO añade esas cabeceras (un reset de contraseña no las lleva)', async () => {
      sendMailMock.mockResolvedValue({ messageId: '<abc@x>' });
      await svc.send(svc.parseConfig(VALID), { to: 'a@b.com', subject: 's', text: 't' });
      const arg = sendMailMock.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg).not.toHaveProperty('list');
      expect(arg).not.toHaveProperty('headers');
    });

    it('con fromName arma el From como { name, address } (firma con el tenant)', async () => {
      sendMailMock.mockResolvedValue({ messageId: '<abc@x>' });
      await svc.send(
        svc.parseConfig(VALID),
        { to: 'a@b.com', subject: 's', text: 't' },
        'Academia X',
      );
      expect(sendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({ from: { name: 'Academia X', address: VALID.from } }),
      );
    });

    it('sanea el fromName (evita inyección de headers con CRLF/comillas)', async () => {
      sendMailMock.mockResolvedValue({ messageId: '<abc@x>' });
      await svc.send(
        svc.parseConfig(VALID),
        { to: 'a@b.com', subject: 's', text: 't' },
        'Mal\r\nBcc: victim@x.com "raro"',
      );
      const arg = sendMailMock.mock.calls[0]![0] as { from: { name: string; address: string } };
      expect(arg.from.name).not.toContain('\n');
      expect(arg.from.name).not.toContain('\r');
      expect(arg.from.name).not.toContain('"');
    });

    it('devuelve ok=false si el transporter rechaza', async () => {
      sendMailMock.mockRejectedValue(new Error('connection refused'));
      const result = await svc.send(svc.parseConfig(VALID), {
        to: 'a@b.com',
        subject: 'x',
        text: 'y',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('connection refused');
      expect(closeMock).toHaveBeenCalled(); // close incluso en error
    });

    it('puerto 465 → secure=true automático', async () => {
      const nodemailer = (await import('nodemailer')).default;
      const createTransport = nodemailer.createTransport as unknown as ReturnType<typeof vi.fn>;
      sendMailMock.mockResolvedValue({ messageId: 'x' });

      await svc.send(svc.parseConfig({ ...VALID, port: 465 }), {
        to: 'a@b.com',
        subject: 's',
        text: 't',
      });

      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ port: 465, secure: true }),
      );
    });

    it('puerto 587 → secure=false (STARTTLS)', async () => {
      const nodemailer = (await import('nodemailer')).default;
      const createTransport = nodemailer.createTransport as unknown as ReturnType<typeof vi.fn>;
      createTransport.mockClear();
      sendMailMock.mockResolvedValue({ messageId: 'x' });

      await svc.send(svc.parseConfig(VALID), { to: 'a@b.com', subject: 's', text: 't' });

      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ port: 587, secure: false }),
      );
    });
  });

  // Modo de cifrado explícito (issue #60: el boolean legado solo modelaba TLS
  // implícito y reventaba contra proveedores STARTTLS en el 587).
  describe('encryption explícito → opciones de nodemailer', () => {
    async function transportOptionsFor(config: Record<string, unknown>) {
      const nodemailer = (await import('nodemailer')).default;
      const createTransport = nodemailer.createTransport as unknown as ReturnType<typeof vi.fn>;
      createTransport.mockClear();
      sendMailMock.mockResolvedValue({ messageId: 'x' });
      await svc.send(svc.parseConfig(config), { to: 'a@b.com', subject: 's', text: 't' });
      return createTransport.mock.calls[0]![0] as Record<string, unknown>;
    }

    it('tls → secure=true (TLS implícito)', async () => {
      const opts = await transportOptionsFor({ ...VALID, port: 465, encryption: 'tls' });
      expect(opts).toMatchObject({ secure: true });
      expect(opts).not.toHaveProperty('requireTLS');
      expect(opts).not.toHaveProperty('ignoreTLS');
    });

    it('starttls → secure=false + requireTLS (upgrade obligatorio, nunca degrada a claro)', async () => {
      const opts = await transportOptionsFor({ ...VALID, encryption: 'starttls' });
      expect(opts).toMatchObject({ secure: false, requireTLS: true });
    });

    it('none → secure=false + ignoreTLS (sin upgrade oportunista)', async () => {
      const opts = await transportOptionsFor({ ...VALID, port: 1025, encryption: 'none' });
      expect(opts).toMatchObject({ secure: false, ignoreTLS: true });
    });

    it('encryption gana al boolean legado si conviven', async () => {
      // Config guardada con el default viejo (secure:true) que el admin
      // corrige a STARTTLS: debe negociar STARTTLS aunque `secure` diga tls.
      const opts = await transportOptionsFor({ ...VALID, secure: true, encryption: 'starttls' });
      expect(opts).toMatchObject({ secure: false, requireTLS: true });
    });

    it('sin encryption → comportamiento legado intacto (boolean o puerto)', async () => {
      const opts = await transportOptionsFor({ ...VALID, secure: false });
      expect(opts).toMatchObject({ secure: false });
      expect(opts).not.toHaveProperty('requireTLS');
      expect(opts).not.toHaveProperty('ignoreTLS');
    });

    it('rechaza un modo desconocido', () => {
      expect(() => svc.parseConfig({ ...VALID, encryption: 'ssl3' })).toThrow();
    });
  });

  describe('verify', () => {
    it('ok cuando el handshake responde', async () => {
      verifyMock.mockResolvedValue(true);
      const result = await svc.verify(svc.parseConfig(VALID));
      expect(result.ok).toBe(true);
    });
    it('fallo cuando el handshake rechaza', async () => {
      verifyMock.mockRejectedValue(new Error('auth failed'));
      const result = await svc.verify(svc.parseConfig(VALID));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('auth failed');
    });
  });
});
