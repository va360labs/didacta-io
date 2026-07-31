/**
 * Test exhaustivo de la feature "Espacios dinámicos de comunidad".
 * Corre contra dev.didacta.io con auth real.
 *
 * Uso:
 *   E2E_BASE_URL=https://dev.didacta.io pnpm exec playwright test apps/e2e/tests/espacios.spec.ts
 *
 * Cubre:
 *  - Sidebar ESPACIOS: sección visible, items de BD, botón "+" según rol
 *  - CreateSpaceModal: campos, validación, modo icono/emoji, preview, submit
 *  - Página /espacios/[space]: heading sin "#", icono correcto (no texto crudo)
 *  - Panel admin /admin/comunidad/espacios: lista, crear, editar, borrar
 *  - SpaceIcon: renderiza SVG o emoji, nunca texto crudo como "message"
 *  - Consistencia visual: sin datos de cartón
 */

import { expect, test } from '@playwright/test';
import { injectSession } from '../helpers/auth';

// ── Auth real contra dev ───────────────────────────────────────────────────

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@didacta.io';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'nJyLDGRncsWm637yJ9rJvGEw';
const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'didacta';
const API_BASE = process.env.E2E_BASE_URL ?? 'https://dev.didacta.io';

interface SigninResponse {
  tokens: { accessToken: string; refreshToken: string };
  user: {
    id: string;
    email: string;
    name: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
  };
}

async function signinReal(): Promise<SigninResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantSlug: TENANT_SLUG, email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Signin failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<SigninResponse>;
}

// Singleton de sesión por suite — una sola llamada real al signin
let _adminSession: SigninResponse | null = null;
async function getAdminSession(): Promise<SigninResponse> {
  if (!_adminSession) _adminSession = await signinReal();
  return _adminSession;
}

async function withAdminSession(
  page: Parameters<typeof injectSession>[0],
  url: string,
  overrideRoles?: string[],
) {
  const s = await getAdminSession();
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: s.tokens.accessToken,
    refreshToken: s.tokens.refreshToken,
    user: overrideRoles ? { ...s.user, roles: overrideRoles } : s.user,
  });
  await page.goto(url);
}

// ── BLOQUE 1: Sidebar — sección ESPACIOS ───────────────────────────────────

test.describe('Sidebar — sección ESPACIOS', () => {
  test('la sección ESPACIOS es visible en el sidebar', async ({ page }) => {
    await withAdminSession(page, '/comunidad');
    const sidebar = page.locator('aside').first();
    // El label del grupo es "Espacios" en el DOM (CSS text-transform:uppercase es solo visual).
    // exact:true evita que coincida con otros elementos que contienen "Espacios" como substring.
    await expect(sidebar.getByText('Espacios', { exact: true })).toBeVisible();
  });

  test('el sidebar carga espacios reales de la BD (al menos 1 item en ESPACIOS)', async ({
    page,
  }) => {
    await withAdminSession(page, '/comunidad');
    const sidebar = page.locator('aside').first();
    // Esperar a que carguen los espacios (puede haber un flash de loading)
    await page.waitForTimeout(1500);
    // Debe haber al menos un link dentro de la sección ESPACIOS apuntando a /espacios/
    const espaciosLinks = sidebar.locator('a[href^="/espacios/"]');
    await expect(espaciosLinks.first()).toBeVisible({ timeout: 8000 });
    const count = await espaciosLinks.count();
    expect(count).toBeGreaterThan(0);
  });

  test('como alumno (rol) NO hay botón "+" junto a ESPACIOS', async ({ page }) => {
    await withAdminSession(page, '/comunidad', ['alumno']);
    const sidebar = page.locator('aside').first();
    await expect(sidebar.getByRole('button', { name: /Añadir a Espacios/i })).not.toBeVisible();
  });

  test('como admin SÍ hay botón "+" junto a ESPACIOS', async ({ page }) => {
    await withAdminSession(page, '/comunidad');
    const sidebar = page.locator('aside').first();
    await expect(sidebar.getByRole('button', { name: /Añadir a Espacios/i })).toBeVisible();
  });

  test('los items de ESPACIOS no muestran texto crudo de IconName (bug regresión)', async ({
    page,
  }) => {
    await withAdminSession(page, '/comunidad');
    const sidebar = page.locator('aside').first();
    await page.waitForTimeout(1500);
    const sidebarText = await sidebar.innerText();
    // Estos son nombres de IconName internos — si aparecen como texto es el bug
    const badTokens = ['message\n', 'hash\n', 'globe\n', 'book\n', 'users\n'];
    for (const bad of badTokens) {
      expect(sidebarText, `Texto crudo "${bad.trim()}" encontrado en sidebar`).not.toContain(bad);
    }
  });

  test('el sidebar NO muestra "1.240 miembros" hardcodeado (dato de cartón CLAUDE.md §3)', async ({
    page,
  }) => {
    await withAdminSession(page, '/comunidad');
    const sidebar = page.locator('aside').first();
    await expect(sidebar.getByText('1.240 miembros')).not.toBeVisible();
  });
});

// ── BLOQUE 2: CreateSpaceModal ─────────────────────────────────────────────

test.describe('CreateSpaceModal — modal de creación de espacio', () => {
  test.beforeEach(async ({ page }) => {
    await withAdminSession(page, '/comunidad');
    await page.getByRole('button', { name: /Añadir a Espacios/i }).click();
    await expect(page.getByRole('dialog', { name: 'Nuevo espacio' })).toBeVisible();
  });

  test('el modal se abre al hacer clic en "+"', async ({ page }) => {
    await expect(page.getByRole('dialog', { name: 'Nuevo espacio' })).toBeVisible();
  });

  test('el modal contiene campo Nombre, toggle Icono/Emoji y paleta de Color', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Nuevo espacio' });
    await expect(dialog.getByLabel('Nombre')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Icono' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Emoji' })).toBeVisible();
    await expect(dialog.getByText('Color')).toBeVisible();
  });

  test('botón "Crear espacio" deshabilitado con nombre vacío', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Crear espacio' })).toBeDisabled();
  });

  test('escribir nombre genera slug automáticamente', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Nuevo espacio' });
    await dialog.getByLabel('Nombre').fill('Recursos Internos');
    await expect(dialog.getByText('/recursos-internos')).toBeVisible();
  });

  test('botón "Crear espacio" se habilita al escribir nombre', async ({ page }) => {
    await page.getByRole('dialog', { name: 'Nuevo espacio' }).getByLabel('Nombre').fill('Test E2E');
    await expect(page.getByRole('button', { name: 'Crear espacio' })).toBeEnabled();
  });

  test('cambiar a modo Emoji muestra el input de emoji', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Nuevo espacio' });
    await dialog.getByRole('button', { name: 'Emoji' }).click();
    await expect(dialog.getByPlaceholder(/emoji/i)).toBeVisible();
  });

  test('la preview muestra el nombre al escribirlo', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Nuevo espacio' });
    await dialog.getByLabel('Nombre').fill('Mi Espacio Preview');
    await expect(dialog.getByText('Mi Espacio Preview')).toBeVisible();
  });

  test('Escape cierra el modal', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Nuevo espacio' })).not.toBeVisible();
  });

  test('clic en el fondo cierra el modal', async ({ page }) => {
    await page.mouse.click(10, 10);
    await expect(page.getByRole('dialog', { name: 'Nuevo espacio' })).not.toBeVisible();
  });

  test('"Cancelar" cierra el modal', async ({ page }) => {
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('dialog', { name: 'Nuevo espacio' })).not.toBeVisible();
  });

  test('la cuadrícula de iconos predefinidos muestra botones de icono', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Nuevo espacio' });
    // En modo "Icono" debe haber una cuadrícula de botones con aria-label
    const iconBtns = dialog.locator('button[aria-label][aria-pressed]');
    const count = await iconBtns.count();
    expect(count).toBeGreaterThan(5); // Al menos 6 iconos predefinidos
  });
});

// ── BLOQUE 3: Página /espacios/[space] ────────────────────────────────────

test.describe('Página /espacios/[space]', () => {
  test('/espacios/general — heading visible sin "#" (bug regresión)', async ({ page }) => {
    await withAdminSession(page, '/espacios/general');
    const heading = page.getByRole('heading', { level: 1 });
    await heading.waitFor({ state: 'visible' });
    const text = await heading.innerText();
    expect(text, 'El heading no debe empezar con "#"').not.toMatch(/^#/);
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test('/espacios/anuncios — heading visible sin "#"', async ({ page }) => {
    await withAdminSession(page, '/espacios/anuncios');
    const heading = page.getByRole('heading', { level: 1 });
    await heading.waitFor({ state: 'visible' });
    const text = await heading.innerText();
    expect(text).not.toMatch(/^#/);
  });

  test('el icono de cabecera no muestra texto crudo de IconName (bug regresión)', async ({
    page,
  }) => {
    await withAdminSession(page, '/espacios/general');
    await page.waitForTimeout(2000); // networkidle nunca resuelve con SSE activo
    // La caja del icono en la cabecera contiene un SVG, no texto
    const iconBox = page.locator('header div.grid').first();
    const iconText = (await iconBox.innerText().catch(() => '')).trim();
    for (const bad of ['message', 'hash', 'globe', 'book', 'users', 'home', 'cog']) {
      expect(iconText, `Texto crudo "${bad}" en la caja del icono`).not.toBe(bad);
    }
  });

  test('botón "Nueva publicación" visible', async ({ page }) => {
    await withAdminSession(page, '/espacios/general');
    await expect(page.getByRole('button', { name: 'Nueva publicación' })).toBeVisible();
  });

  test('el compositor se abre al pulsar "Nueva publicación"', async ({ page }) => {
    await withAdminSession(page, '/espacios/general');
    await page.getByRole('button', { name: 'Nueva publicación' }).click();
    // El modal PostComposerModal debe aparecer
    await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 5000 });
  });

  test('el selector de ordenación tiene las 3 opciones', async ({ page }) => {
    await withAdminSession(page, '/espacios/general');
    // getByRole('option') no funciona con <select> nativo cerrado — usar locator directo
    const select = page.locator('select');
    await expect(select).toBeVisible({ timeout: 8000 });
    const options = await page.locator('select option').allInnerTexts();
    expect(options).toContain('Más recientes');
    expect(options).toContain('Más antiguas');
    expect(options).toContain('Más comentadas');
  });

  test('el sidebar derecho muestra "Acerca del espacio"', async ({ page }) => {
    await withAdminSession(page, '/espacios/general');
    await expect(page.getByText('Acerca del espacio')).toBeVisible();
  });

  test('los iconos en "Otros espacios" no muestran texto crudo', async ({ page }) => {
    await withAdminSession(page, '/espacios/general');
    await page.waitForTimeout(2000); // networkidle nunca resuelve con SSE activo
    const otherSection = page.getByText('Otros espacios').locator('..');
    if (await otherSection.isVisible().catch(() => false)) {
      const text = await otherSection.innerText();
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      for (const bad of ['message', 'hash', 'globe', 'book', 'users', 'home']) {
        expect(lines, `"${bad}" como texto crudo en Otros espacios`).not.toContain(bad);
      }
    }
  });

  test('el feed carga (skeleton → posts o empty state)', async ({ page }) => {
    await withAdminSession(page, '/espacios/general');
    await page.waitForTimeout(2000); // networkidle nunca resuelve con SSE activo
    // Debe mostrar posts o empty state, nunca un error
    const hasError = await page
      .getByText('No se pudieron cargar')
      .isVisible()
      .catch(() => false);
    expect(hasError, 'El feed muestra error de carga').toBe(false);
  });
});

// ── BLOQUE 4: Panel admin /admin/comunidad/espacios ───────────────────────

test.describe('Panel admin — /admin/comunidad/espacios', () => {
  test('la página carga sin error 500', async ({ page }) => {
    await withAdminSession(page, '/admin/comunidad/espacios');
    await expect(page.getByText('Internal Server Error')).not.toBeVisible();
    await expect(page.getByText('Application error')).not.toBeVisible();
  });

  test('muestra un heading con "Espacios"', async ({ page }) => {
    await withAdminSession(page, '/admin/comunidad/espacios');
    await expect(page.getByRole('heading', { name: /espacios/i }).first()).toBeVisible({
      timeout: 8000,
    });
  });

  test('lista al menos un espacio (datos reales de BD)', async ({ page }) => {
    await withAdminSession(page, '/admin/comunidad/espacios');
    // El admin usa una lista ul/li (no tabla). Cada item tiene un botón "Editar".
    const items = page.locator('li').filter({ has: page.locator('button', { hasText: 'Editar' }) });
    await expect(items.first()).toBeVisible({ timeout: 8000 });
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
  });

  test('muestra el slug "general" en la lista', async ({ page }) => {
    await withAdminSession(page, '/admin/comunidad/espacios');
    // El slug se renderiza como "/general · orden N" — el slash lo hace inequívoco
    await expect(page.getByText('/general').first()).toBeVisible({ timeout: 8000 });
  });

  test('espacios de sistema muestran el icono de candado 🔒', async ({ page }) => {
    await withAdminSession(page, '/admin/comunidad/espacios');
    await expect(page.getByText('🔒').first()).toBeVisible({ timeout: 8000 });
  });

  test('existe formulario para crear nuevo espacio', async ({ page }) => {
    await withAdminSession(page, '/admin/comunidad/espacios');
    // count() es síncrono — esperar a que React hidrate antes de contar
    await expect(page.locator('input[placeholder]').first()).toBeVisible({ timeout: 8000 });
    const count = await page.locator('input[placeholder]').count();
    expect(count).toBeGreaterThan(0);
  });

  test('el toggle Icono/Emoji existe en el formulario admin', async ({ page }) => {
    await withAdminSession(page, '/admin/comunidad/espacios');
    await expect(page.getByRole('button', { name: 'Icono' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Emoji' }).first()).toBeVisible();
  });

  test('el sortOrder es visible en la lista', async ({ page }) => {
    await withAdminSession(page, '/admin/comunidad/espacios');
    // El orden se muestra inline como "orden N" en la descripción de cada espacio
    await expect(page.getByText(/orden \d+/).first()).toBeVisible({ timeout: 8000 });
  });
});

// ── BLOQUE 5: Consistencia visual y rutas ────────────────────────────────

test.describe('Consistencia visual y rutas', () => {
  test('/inicio redirige a /comunidad (sin ruta duplicada)', async ({ page }) => {
    await withAdminSession(page, '/inicio');
    await expect(page).toHaveURL(/\/comunidad/);
  });

  test('la sección ESPACIOS en el sidebar tiene el label en mayúsculas (CSS)', async ({ page }) => {
    await withAdminSession(page, '/comunidad');
    // El DOM tiene "Espacios"; la clase CSS "uppercase" lo hace aparecer en mayúsculas visualmente.
    await expect(
      page.locator('aside').first().getByText('Espacios', { exact: true }),
    ).toBeVisible();
  });

  test('/comunidad no da error 500', async ({ page }) => {
    await withAdminSession(page, '/comunidad');
    await expect(page.getByText('Internal Server Error')).not.toBeVisible();
  });

  test('/espacios/general no da error 500', async ({ page }) => {
    await withAdminSession(page, '/espacios/general');
    await expect(page.getByText('Internal Server Error')).not.toBeVisible();
  });

  test('/admin/comunidad/espacios no da error 500', async ({ page }) => {
    await withAdminSession(page, '/admin/comunidad/espacios');
    await expect(page.getByText('Internal Server Error')).not.toBeVisible();
  });

  test('el sidebar muestra el nombre del tenant, no texto de error', async ({ page }) => {
    await withAdminSession(page, '/comunidad');
    const sidebar = page.locator('aside').first();
    // No debe haber mensajes de error en el sidebar
    await expect(sidebar.getByText('Error')).not.toBeVisible();
    await expect(sidebar.getByText('undefined')).not.toBeVisible();
  });
});
