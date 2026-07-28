import { describe, expect, it } from 'vitest';
import { invitationEmailHtml } from '../src/common/invitation-email';

const branding = {
  tenantName: 'VA360',
  logoUrl: 'https://aula.va360.academy/logo.png',
  brandColor: '#1E5AA8',
};

const contenido = {
  greeting: 'Hola Ana,',
  resetUrl: 'https://aula.va360.academy/reset-password?token=abc123',
  validezDias: 7,
};

describe('email de invitación al aula', () => {
  it('lleva el enlace personal en el botón y también en texto plano', () => {
    const { html, text } = invitationEmailHtml(branding, contenido);
    // Dos veces en el HTML: el botón y el enlace de respaldo para quien no
    // pueda pulsarlo (clientes que no pintan botones).
    expect(html.split(contenido.resetUrl).length - 1).toBeGreaterThanOrEqual(2);
    expect(text).toContain(contenido.resetUrl);
  });

  it('dice la validez real del enlace en vez de una cifra inventada', () => {
    const { html } = invitationEmailHtml(branding, contenido);
    expect(html).toContain('vale 7 días');
  });

  it('es un correo DISTINTO al de restablecer contraseña', () => {
    const { subject, html } = invitationEmailHtml(branding, contenido);
    expect(subject).toBe('Tu cuenta del aula de VA360 ya está lista');
    // El mensaje que lo diferencia: la cuenta ya existe y no hay que comprar
    // nada de nuevo. Un reset jamás diría esto.
    expect(html).toContain('tu cuenta ya está creada');
    expect(html).toContain('seguirá funcionando con normalidad');
    expect(subject.toLowerCase()).not.toContain('contraseña');
  });

  it('usa el logo del tenant y cae al nombre si no hay', () => {
    expect(invitationEmailHtml(branding, contenido).html).toContain(branding.logoUrl);
    const sinLogo = invitationEmailHtml({ ...branding, logoUrl: null }, contenido).html;
    expect(sinLogo).toContain('VA360');
    expect(sinLogo).not.toContain('<img');
  });

  it('escapa el contenido para que un nombre con HTML no rompa el correo', () => {
    const { html } = invitationEmailHtml(branding, {
      ...contenido,
      greeting: 'Hola <script>alert(1)</script>,',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
