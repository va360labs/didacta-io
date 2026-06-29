/**
 * Envuelve el cuerpo (texto plano editado por el admin) en HTML simple y seguro
 * para el email de recordatorio de renovación/pago: escapa HTML, convierte URLs en
 * enlaces y saltos de línea en <br>. El enlace de renovación ya viene incrustado en
 * el texto que el admin revisó.
 *
 * Compartido por el dashboard de control de suscripciones (mod.payment-connections)
 * y el panel de solicitudes de inscripción (core), que envían el MISMO email.
 */
export function renewalEmailHtml(body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const linked = escaped
    .replace(/(https?:\/\/[^\s<]+)/g, (match) => {
      // No metas la puntuación final (.,;:!?)]) dentro del href si el admin la
      // pegó al enlace: la dejamos fuera del <a>.
      const trail = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? '';
      const url = trail ? match.slice(0, match.length - trail.length) : match;
      return `<a href="${url}">${url}</a>${trail}`;
    })
    .replace(/\n/g, '<br>');
  return (
    `<!DOCTYPE html><html lang="es"><body style="font-family:'Inter',system-ui,sans-serif;color:#0D1B2A;line-height:1.6;">` +
    `${linked}` +
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;" />` +
    `<p style="font-size:12px;color:#999;margin:0;">Powered by Didacta.io</p>` +
    `</body></html>`
  );
}
