import { renderBrandedEmail, escapeHtml, type EmailBranding } from './branded-email';

/**
 * Email de INVITACIÓN al aula: el que recibe alguien cuya cuenta ya existe pero
 * aún no ha entrado nunca.
 *
 * Tiene copy propio y no reutiliza el del restablecimiento de contraseña,
 * porque son dos correos distintos: uno lo pide el usuario y se lee al momento;
 * este llega sin avisar y tiene que explicar qué es, por qué lo recibe y qué
 * gana entrando. La maqueta sí es la compartida de marca del TENANT
 * (`renderBrandedEmail`): header con su logo, color de marca, botón CTA y
 * footer "Powered by Didacta" — así la invitación de cada academia sale con su
 * propia identidad sin duplicar HTML de email.
 */
export interface InvitationEmailContent {
  /** Saludo ya resuelto («Hola Ana,» o «Hola,»). */
  greeting: string;
  /** Enlace personal para definir la contraseña. */
  resetUrl: string;
  /** Días de validez del enlace, para decirlo sin mentir. */
  validezDias: number;
}

export function invitationEmailHtml(
  branding: EmailBranding,
  content: InvitationEmailContent,
): { subject: string; html: string; text: string } {
  const tenant = branding.tenantName;
  const subject = `${tenant} te ha invitado a su aula`;
  const validez = `${content.validezDias} ${content.validezDias === 1 ? 'día' : 'días'}`;

  const bodyText = `${content.greeting}

${tenant} te ha invitado a su aula y tu cuenta ya está creada. No tienes que registrarte: solo elegir una contraseña para entrar por primera vez.

El enlace es personal y vale ${validez}.

Si te atascas en cualquier paso, responde a este correo y te echamos una mano.`;

  const bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(content.greeting)}</p>
  <p style="margin:0 0 12px;"><strong>${escapeHtml(tenant)}</strong> te ha invitado a su aula y <strong>tu cuenta ya está creada</strong>. No tienes que registrarte: solo elegir una contraseña para entrar por primera vez.</p>
  <ol style="margin:0 0 12px;padding-left:20px;">
    <li style="margin:0 0 6px;">Pulsa el botón de abajo: te lleva directo a elegir tu contraseña.</li>
    <li style="margin:0 0 6px;">Completa tu perfil en un par de pasos.</li>
    <li style="margin:0;">Listo: ya puedes entrar al aula cuando quieras.</li>
  </ol>
  <p style="margin:0 0 12px;font-size:14px;color:#5b6b7c;">Tarda menos de un minuto · el enlace es personal y vale ${validez}.</p>
  <p style="margin:0;font-size:14px;color:#5b6b7c;">¿No funciona el botón? Copia este enlace en tu navegador:<br /><span style="word-break:break-all;">${escapeHtml(content.resetUrl)}</span></p>
  <p style="margin:12px 0 0;font-size:14px;color:#5b6b7c;">Si te atascas en cualquier paso, responde a este correo y te echamos una mano.</p>`;

  const { html, text } = renderBrandedEmail(branding, {
    title: 'Tu cuenta ya está lista',
    bodyHtml,
    bodyText,
    cta: { url: content.resetUrl, label: 'Crear mi contraseña y entrar' },
    footerNote: `Recibes este correo porque ${tenant} te ha dado de alta en su aula.`,
  });

  return { subject, html, text };
}
