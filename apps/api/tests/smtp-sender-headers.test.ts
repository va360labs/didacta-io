import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmtpAdapterService, type SmtpSendConfig } from '../src/modules/smtp-adapter.service';

/**
 * Cabeceras REALES: aquí nodemailer no está simulado. Se sustituye el
 * transporte SMTP por uno que solo serializa el mensaje, y se mira el texto
 * crudo que saldría por el cable — que es lo que lee el cliente de correo.
 */
const CONFIG: SmtpSendConfig = {
  host: 'smtp.example.test',
  port: 587,
  user: 'u',
  password: 'p',
  from: 'hola@didacta.io',
};

async function rawHeaders(config: SmtpSendConfig, fromName?: string): Promise<string> {
  const stream = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: '\r\n',
  });
  let raw = '';
  const realSend = stream.sendMail.bind(stream);
  vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
    sendMail: async (opts: unknown) => {
      const info = (await realSend(opts as never)) as { message: Buffer; messageId: string };
      raw = info.message.toString('utf8');
      return info;
    },
    verify: async () => true,
    close: () => undefined,
  } as never);
  const result = await new SmtpAdapterService().send(
    config,
    { to: 'alumno@example.test', subject: 'Hola', text: 'cuerpo' },
    fromName,
  );
  expect(result.ok).toBe(true);
  return raw.split('\r\n\r\n')[0]!;
}

function header(headers: string, name: string): string[] {
  return headers
    .replace(/\r\n[ \t]+/g, ' ')
    .split('\r\n')
    .filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
}

afterEach(() => vi.restoreAllMocks());

describe('SmtpAdapterService.send — cabeceras serializadas', () => {
  it('nombre de la academia codificado RFC 2047 + dirección de la plataforma + Reply-To', async () => {
    const h = await rawHeaders(
      { ...CONFIG, sender: { fallbackName: 'Didacta', replyTo: 'creador@academia.es' } },
      'Academia Ñandú de Pruebas',
    );
    const from = header(h, 'From');
    expect(from).toHaveLength(1);
    expect(from[0]).toMatch(/^From: =\?UTF-8\?[QB]\?.+\?= <hola@didacta\.io>$/);
    // Decodificado vuelve a ser exactamente el nombre.
    const word = from[0]!.match(/=\?UTF-8\?Q\?(.+)\?=/)?.[1];
    if (word) {
      const decoded = Buffer.from(
        word
          .replace(/_/g, ' ')
          .replace(/=([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))),
        'latin1',
      ).toString('utf8');
      expect(decoded).toBe('Academia Ñandú de Pruebas');
    }
    expect(header(h, 'Reply-To')).toEqual(['Reply-To: creador@academia.es']);
  });

  it('intento de inyección "Academia\\r\\nBcc: x@y": ni Bcc ni línea extra en las cabeceras', async () => {
    const h = await rawHeaders(CONFIG, 'Academia\r\nBcc: x@y');
    expect(header(h, 'Bcc')).toEqual([]);
    expect(h).not.toContain('x@y');
    // nodemailer entrecomilla el nombre (lleva «:»): sigue siendo UNA cabecera From.
    expect(header(h, 'From')).toEqual(['From: "Academia Bcc: x y" <hola@didacta.io>']);
  });

  it('un nombre con forma de dirección no aparece como segunda dirección en el From', async () => {
    const h = await rawHeaders(CONFIG, 'Soporte <seguridad@banco.com>');
    const from = header(h, 'From')[0]!;
    expect(from.match(/</g)).toHaveLength(1);
    expect(from).toContain('<hola@didacta.io>');
    expect(from).not.toContain('@banco.com');
  });

  it('sin nombre de academia: se firma con el de la plataforma; sin identidad, la dirección sola', async () => {
    expect(
      header(await rawHeaders({ ...CONFIG, sender: { fallbackName: 'Didacta' } }), 'From'),
    ).toEqual(['From: Didacta <hola@didacta.io>']);
    expect(header(await rawHeaders(CONFIG), 'From')).toEqual(['From: hola@didacta.io']);
  });

  it('sin Reply-To configurado no se inventa ninguno (control)', async () => {
    expect(header(await rawHeaders(CONFIG, 'Academia'), 'Reply-To')).toEqual([]);
  });

  it('SMTP propio con nombre fijado: manda sobre el que pasa el emisor', async () => {
    const h = await rawHeaders(
      { ...CONFIG, from: 'yo@miacademia.es', sender: { fixedName: 'Mi Marca' } },
      'Nombre del aula',
    );
    expect(header(h, 'From')).toEqual(['From: Mi Marca <yo@miacademia.es>']);
  });
});
