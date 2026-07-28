import type { EmailBranding } from './branded-email';

/**
 * Email de INVITACIÓN al aula: el que recibe alguien cuya cuenta ya existe pero
 * aún no ha entrado nunca.
 *
 * Tiene maqueta propia y no reutiliza la del restablecimiento de contraseña,
 * porque son dos correos distintos: uno lo pide el usuario y se lee al momento;
 * este llega sin avisar y tiene que explicar qué es, por qué lo recibe y qué
 * gana entrando. Compartir plantilla obligaba a que un "olvidé mi contraseña"
 * sonara a campaña de bienvenida.
 *
 * Escrito con tablas y estilos en línea: Gmail y Outlook ignoran las hojas de
 * estilo y buena parte de CSS moderno. Se entiende con las imágenes bloqueadas,
 * que es como lo verá mucha gente.
 */
export interface InvitationEmailContent {
  /** Saludo ya resuelto («Hola Ana,» o «Hola,»). */
  greeting: string;
  /** Enlace personal para definir la contraseña. */
  resetUrl: string;
  /** Días de validez del enlace, para decirlo sin mentir. */
  validezDias: number;
}

const ORO = '#e5b94e';
const ORO_OSCURO = '#8a5c08';
const NOCHE = '#0d1b2a';
const TEXTO = '#334155';

export function invitationEmailHtml(
  branding: EmailBranding,
  content: InvitationEmailContent,
): { subject: string; html: string; text: string } {
  const tenant = escapeHtml(branding.tenantName);
  const subject = `Tu cuenta del aula de ${branding.tenantName} ya está lista`;

  const cabecera =
    branding.logoUrl && /^https?:\/\//i.test(branding.logoUrl)
      ? `<img src="${escapeAttr(branding.logoUrl)}" alt="${escapeAttr(branding.tenantName)}" width="150" style="display:block;width:150px;max-width:60%;height:auto;border:0;" />`
      : `<span style="font-size:24px;font-weight:700;color:#ffffff;">${tenant}</span>`;

  const paso = (n: number, texto: string) => `
    <tr>
      <td width="34" valign="top" style="padding:0 12px 16px 0;">
        <div style="width:26px;height:26px;line-height:26px;text-align:center;border-radius:13px;background-color:${NOCHE};color:#ffffff;font-size:13px;font-weight:bold;font-family:Arial,Helvetica,sans-serif;">${n}</div>
      </td>
      <td valign="top" style="padding:0 0 16px 0;font-size:15px;line-height:1.55;color:${TEXTO};">${texto}</td>
    </tr>`;

  const ventaja = (texto: string) =>
    `<p style="margin:0 0 8px 0;font-size:15px;line-height:1.55;color:${TEXTO};">&#10003;&nbsp; ${texto}</p>`;

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f3f5;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#ffffff;border-radius:14px;overflow:hidden;">
      <tr>
        <td align="center" style="background-color:${NOCHE};padding:32px 24px 28px 24px;">
          ${cabecera}
          <p style="margin:16px 0 0 0;color:${ORO};font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-weight:bold;">Tu nueva aula</p>
        </td>
      </tr>
      <tr>
        <td style="padding:36px 40px 8px 40px;font-family:Arial,Helvetica,sans-serif;">
          <h1 style="margin:0 0 18px 0;font-size:26px;line-height:1.25;color:${NOCHE};font-weight:bold;">Hemos mudado tus cursos a un aula nueva</h1>
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:${TEXTO};">${escapeHtml(content.greeting)}</p>
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:${TEXTO};">
            Hemos estrenado el aula de ${tenant} y <strong>tu cuenta ya está creada</strong>, con tus cursos dentro.
            No tienes que registrarte ni volver a comprar nada: solo elegir una contraseña para entrar por primera vez.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 40px 4px 40px;font-family:Arial,Helvetica,sans-serif;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fffaec;border-left:4px solid ${ORO};border-radius:0 10px 10px 0;">
            <tr><td style="padding:18px 22px;">
              <p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:${TEXTO};">
                <strong>No pierdes nada.</strong> El aula que usas ahora seguirá funcionando con normalidad y de forma
                indefinida: no hay fecha de cierre ni tienes que darte prisa.
              </p>
              <p style="margin:0;font-size:15px;line-height:1.6;color:${TEXTO};">
                La diferencia es que las novedades pasan a estar aquí: los cursos nuevos, las clases en directo y todo
                lo que preparemos a partir de ahora.
              </p>
            </td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td align="center" style="padding:26px 40px 8px 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center" bgcolor="${ORO}" style="border-radius:10px;background:linear-gradient(180deg,#f9e7a0 0%,#eec95c 55%,#d9a92f 100%);">
              <a href="${escapeAttr(content.resetUrl)}" style="display:inline-block;padding:16px 38px;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:bold;color:#3b2b00;text-decoration:none;border-radius:10px;">Crear mi contraseña y entrar</a>
            </td></tr>
          </table>
          <p style="margin:14px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#64748b;">
            Tarda menos de un minuto · el enlace es personal y vale ${content.validezDias} días
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 40px 8px 40px;font-family:Arial,Helvetica,sans-serif;">
          <p style="margin:0 0 14px 0;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:${ORO_OSCURO};font-weight:bold;">Cómo entrar, paso a paso</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${paso(1, 'Pulsa el botón de arriba: te lleva directo a elegir tu contraseña.')}
            ${paso(2, 'Completa tu perfil en un par de pasos.')}
            ${paso(3, 'Listo. Verás <strong>Mis cursos</strong> con todo lo que ya tienes.')}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;border-radius:12px;">
            <tr><td style="padding:22px 24px;">
              <p style="margin:0 0 12px 0;font-size:15px;font-weight:bold;color:${NOCHE};">Lo que te espera dentro</p>
              ${ventaja('Tus cursos, con el progreso guardado lección a lección')}
              ${ventaja('Las clases en directo y sus grabaciones')}
              ${ventaja('La comunidad, para preguntar y compartir con el resto')}
              ${ventaja('Tu certificado al completar cada curso')}
            </td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:26px 40px 32px 40px;font-family:Arial,Helvetica,sans-serif;">
          <p style="margin:0 0 6px 0;font-size:13px;line-height:1.6;color:#64748b;">¿No funciona el botón? Copia y pega esta dirección en tu navegador:</p>
          <p style="margin:0;font-size:13px;line-height:1.6;word-break:break-all;"><a href="${escapeAttr(content.resetUrl)}" style="color:#1e5aa8;">${escapeHtml(content.resetUrl)}</a></p>
          <p style="margin:22px 0 0 0;font-size:15px;line-height:1.6;color:${TEXTO};">Si te atascas en cualquier paso, responde a este correo y te echamos una mano.</p>
          <p style="margin:18px 0 0 0;font-size:15px;line-height:1.6;color:${TEXTO};">Nos vemos dentro,<br /><strong>El equipo de ${tenant}</strong></p>
        </td>
      </tr>
      <tr>
        <td align="center" style="background-color:${NOCHE};padding:24px 32px;font-family:Arial,Helvetica,sans-serif;">
          <p style="margin:0 0 6px 0;font-size:13px;color:${ORO};font-weight:bold;">${tenant}</p>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;">Recibes este correo porque tienes cursos con nosotros.</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`;

  const text = [
    content.greeting,
    '',
    `Hemos estrenado el aula de ${branding.tenantName} y tu cuenta ya está creada, con tus cursos dentro.`,
    'No tienes que registrarte ni volver a comprar nada: solo elegir una contraseña.',
    '',
    'No pierdes nada: el aula que usas ahora seguirá funcionando con normalidad y de forma indefinida.',
    'La diferencia es que las novedades pasan a estar aquí.',
    '',
    `Entra desde este enlace personal (vale ${content.validezDias} días):`,
    content.resetUrl,
    '',
    'Si te atascas, responde a este correo y te echamos una mano.',
  ].join('\n');

  return { subject, html, text };
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(v: string): string {
  return escapeHtml(v).replace(/'/g, '&#39;');
}
