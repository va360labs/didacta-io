/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Buzón de pruebas del arnés (Mailpit de `docker-compose.test.yml`, variables
 * en `scripts/e2e-env.sh`). Un spec que quiera leer un correo apunta el SMTP
 * de SU aula aquí (`smtpForMailpit`) y lo busca por destinatario: el buzón es
 * compartido, así que cada spec usa direcciones propias y no vacía nada.
 */

export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8026';
const SMTP_HOST = process.env.E2E_MAILPIT_SMTP_HOST ?? '127.0.0.1';
const SMTP_PORT = Number(process.env.E2E_MAILPIT_SMTP_PORT ?? 1026);

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string; Name?: string }>;
  From: { Address: string; Name?: string };
}

export interface MailpitFull extends MailpitMessage {
  Text: string;
  HTML: string;
}

/** Cuerpo del `PUT /admin/tenant-settings/smtp` que manda los correos del aula a Mailpit. */
export function smtpForMailpit(fromEmail: string, fromName: string) {
  return {
    host: SMTP_HOST,
    port: SMTP_PORT,
    encryption: 'none',
    username: 'e2e',
    password: 'e2e',
    fromEmail,
    fromName,
  };
}

/** Los mensajes enviados a `to` (del más reciente al más antiguo). */
export async function mailsTo(to: string): Promise<MailpitMessage[]> {
  const res = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`,
  );
  if (!res.ok) throw new Error(`Mailpit no responde (${res.status}) en ${MAILPIT_URL}`);
  const body = (await res.json()) as { messages?: MailpitMessage[] };
  return (body.messages ?? []).filter((m) =>
    m.To?.some((a) => a.Address.toLowerCase() === to.toLowerCase()),
  );
}

export async function mailById(id: string): Promise<MailpitFull> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
  if (!res.ok) throw new Error(`Mailpit: mensaje ${id} → ${res.status}`);
  return (await res.json()) as MailpitFull;
}

/**
 * Espera a que haya al menos `count` correos para `to` y devuelve el más
 * reciente entero (texto y HTML). Sondea: el envío va detrás de la petición
 * que lo dispara.
 */
export async function waitForMail(to: string, count = 1, timeoutMs = 45_000): Promise<MailpitFull> {
  const deadline = Date.now() + timeoutMs;
  let last: MailpitMessage[] = [];
  while (Date.now() < deadline) {
    last = await mailsTo(to).catch(() => []);
    if (last.length >= count) return mailById(last[0]!.ID);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `No llegaron ${count} correo(s) para ${to} en ${timeoutMs} ms (hay ${last.length})`,
  );
}
