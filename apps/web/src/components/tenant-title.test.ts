import { describe, expect, it } from 'vitest';
import { withTenantBrand } from './tenant-title';

/**
 * Regla del producto: "Didacta" nunca aparece solo en el título cuando hay un
 * tenant resuelto — siempre "<Tenant> powered by Didacta".
 */
describe('withTenantBrand', () => {
  it('reemplaza el sufijo genérico por el del tenant', () => {
    expect(withTenantBrand('Iniciar sesión | Didacta', 'Demo')).toBe(
      'Iniciar sesión | Demo powered by Didacta',
    );
  });

  it('el título por defecto (solo "Didacta") pasa a llevar el tenant', () => {
    expect(withTenantBrand('Didacta', 'Demo')).toBe('Demo powered by Didacta');
  });

  it('es idempotente — reaplicar no encadena sufijos', () => {
    const once = withTenantBrand('Iniciar sesión | Didacta', 'Demo');
    expect(withTenantBrand(once, 'Demo')).toBe(once);
  });

  it('no toca títulos que no siguen el template', () => {
    expect(withTenantBrand('Otra cosa', 'Demo')).toBe('Otra cosa');
  });

  it('un tenant llamado "Didacta" no genera "Didacta powered by Didacta"', () => {
    expect(withTenantBrand('Iniciar sesión | Didacta', 'Didacta')).toBe('Iniciar sesión | Didacta');
  });

  it('un nombre en blanco deja el título como estaba', () => {
    expect(withTenantBrand('Iniciar sesión | Didacta', '   ')).toBe('Iniciar sesión | Didacta');
  });

  it('respeta el nombre real del tenant, espacios incluidos', () => {
    expect(withTenantBrand('Mi panel | Didacta', 'Academia Demo')).toBe(
      'Mi panel | Academia Demo powered by Didacta',
    );
  });
});
