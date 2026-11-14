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
  locale: 'es-ES',
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

// ============================================================================
// Idioma del invitado. La invitación era el único email transaccional sin
// NADA traducido: asunto, los 3 pasos, la nota de validez, el botón y el pie
// salían en español aunque el invitado tuviera `locale = 'en-US'`.
// ============================================================================
describe('email de invitación · idioma del invitado', () => {
  it('un invitado en-US lo recibe ENTERO en inglés, incluidos pasos, botón y pie', () => {
    const { subject, html, text } = invitationEmailHtml(branding, {
      ...contenido,
      greeting: 'Hi Ana,',
      locale: 'en-US',
    });
    expect(subject).toBe('Academia Ejemplo has invited you to their classroom');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('your account is already created');
    // Los 3 pasos de la lista ordenada.
    expect(html).toContain('it takes you straight to choosing your password');
    expect(html).toContain('Complete your profile in a couple of steps');
    expect(html).toContain('you can enter the classroom whenever you like');
    // Botón CTA y pie: las dos piezas estructurales que un override no quita.
    expect(html).toContain('Create my password and get in');
    expect(html).toContain('signed you up to their classroom');
    expect(text).toContain('valid for 7 days');
    // El síntoma del bug: español dentro de un email inglés.
    expect(html).not.toContain('te ha invitado');
    expect(html).not.toContain('Crear mi contraseña');
    expect(html).not.toContain('Recibes este correo porque');
  });

  it('el plural del día también se conjuga en inglés', () => {
    const unDia = invitationEmailHtml(branding, { ...contenido, validezDias: 1, locale: 'en-US' });
    expect(unDia.html).toContain('valid for 1 day');
    expect(unDia.html).not.toContain('1 days');
  });

  it('un invitado es-ES lo recibe byte a byte igual que antes', () => {
    const { subject, html, text } = invitationEmailHtml(branding, contenido);
    expect(subject).toBe('Academia Ejemplo te ha invitado a su aula');
    expect(html).toContain('<html lang="es">');
    expect(html).toContain(
      '<strong>Academia Ejemplo</strong> te ha invitado a su aula y <strong>tu cuenta ya está creada</strong>. No tienes que registrarte: solo elegir una contraseña para entrar por primera vez.',
    );
    expect(html).toContain('Pulsa el botón de abajo: te lleva directo a elegir tu contraseña.');
    expect(html).toContain('Tarda menos de un minuto · el enlace es personal y vale 7 días.');
    expect(html).toContain('¿No funciona el botón? Copia este enlace en tu navegador:');
    expect(html).toContain('Crear mi contraseña y entrar');
    expect(html).toContain(
      'Recibes este correo porque Academia Ejemplo te ha dado de alta en su aula.',
    );
    expect(text).toContain('El enlace es personal y vale 7 días.');
    expect(text).toContain(
      'Si te atascas en cualquier paso, responde a este correo y te echamos una mano.',
    );
  });

  it('un invitado pt-BR lo recibe ENTERO en portugués, incluidos pasos, botón y pie', () => {
    // Era el camino degradado de abajo mientras `pt-BR` fue guardable sin
    // catálogo: el invitado brasileño recibía la invitación entera en español.
    const { subject, html, text } = invitationEmailHtml(branding, {
      ...contenido,
      greeting: 'Olá, Ana!',
      locale: 'pt-BR',
    });
    expect(subject).toBe('Academia Ejemplo convidou você para a escola');
    expect(html).toContain('<html lang="pt">');
    expect(html).toContain(
      '<strong>Academia Ejemplo</strong> convidou você para a escola e <strong>sua conta já está criada</strong>.',
    );
    // Los 3 pasos de la lista ordenada.
    expect(html).toContain('Clique no botão abaixo: ele leva você direto para escolher sua senha.');
    expect(html).toContain('Complete seu perfil em poucos passos.');
    expect(html).toContain('você já pode entrar na escola quando quiser');
    // Botón CTA y pie: las dos piezas estructurales que un override no quita.
    expect(html).toContain('Criar minha senha e entrar');
    expect(html).toContain('Academia Ejemplo cadastrou você na escola');
    expect(html).toContain('Leva menos de um minuto · o link é pessoal e vale por 7 dias.');
    expect(text).toContain('O link é pessoal e vale por 7 dias.');
    // Ni español ni inglés dentro de la invitación portuguesa.
    for (const ajeno of [
      'te ha invitado',
      'Crear mi contraseña',
      'Recibes este correo porque',
      'has invited you',
      'Create my password',
      // El «aula» española (la academia) es «escola»: «sala de aula» es la de Zoom.
      'sala de aula',
    ]) {
      expect(html, `«${ajeno}» se coló en la invitación portuguesa`).not.toContain(ajeno);
    }
  });

  it('el plural del día también se conjuga en portugués', () => {
    const unDia = invitationEmailHtml(branding, { ...contenido, validezDias: 1, locale: 'pt-BR' });
    expect(unDia.html).toContain('vale por 1 dia.');
    expect(unDia.html).not.toContain('1 dias');
  });

  it('CAMINO DEGRADADO: un locale sin catálogo (fr-FR) cae al español, no a un hueco', () => {
    // `fr-FR` es alcanzable por SCIM, que copia el locale del IdP sin validar.
    for (const locale of ['fr-FR', 'zz', '', '   ']) {
      const { subject, html } = invitationEmailHtml(branding, { ...contenido, locale });
      expect(subject, locale).toBe('Academia Ejemplo te ha invitado a su aula');
      expect(html, locale).toContain('<html lang="es">');
      expect(html, locale).toContain('Crear mi contraseña y entrar');
    }
  });
});
