import { describe, expect, it } from 'vitest';
import { invitationEmailHtml } from '../src/common/invitation-email';

const branding = {
  tenantName: 'Academia Ejemplo',
  logoUrl: 'https://academia.example.com/logo.png',
  brandColor: '#1E5AA8',
};

const contenido = {
  greeting: 'Hola Ana,',
  resetUrl: 'https://academia.example.com/reset-password?token=abc123',
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
    // Singular bien conjugado cuando el enlace vale un solo día.
    const unDia = invitationEmailHtml(branding, { ...contenido, validezDias: 1 });
    expect(unDia.html).toContain('vale 1 día');
    expect(unDia.html).not.toContain('1 días');
  });

  it('es un correo DISTINTO al de restablecer contraseña', () => {
    const { subject, html } = invitationEmailHtml(branding, contenido);
    expect(subject).toBe('Academia Ejemplo te ha invitado a su aula');
    // El mensaje que lo diferencia: la cuenta ya existe y no hay que
    // registrarse. Un reset jamás diría esto.
    expect(html).toContain('tu cuenta ya está creada');
    expect(subject.toLowerCase()).not.toContain('contraseña');
  });

  it('usa el logo del tenant y cae al nombre si no hay', () => {
    expect(invitationEmailHtml(branding, contenido).html).toContain(branding.logoUrl);
    const sinLogo = invitationEmailHtml({ ...branding, logoUrl: null }, contenido).html;
    expect(sinLogo).toContain('Academia Ejemplo');
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
