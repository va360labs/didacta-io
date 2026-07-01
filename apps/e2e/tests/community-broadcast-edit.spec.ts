import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec e2e de: editar publicación, baja (unsubscribe) de avisos masivos y avisos
 * masivos (broadcast). API-driven contra el stack local (como los otros specs).
 * Cubre los caminos observables sin infra externa (el envío real por SMTP y el
 * ritmo por lotes del worker se validan aparte / manualmente).
 */

const BASE = `${API_URL}/api/v1/modules/community`;

test.describe('Comunidad · editar post + avisos masivos', () => {
  test('editar un post: PATCH cambia el título y marca editedAt', async () => {
    const token = await adminTokenForBootstrap(process.env.E2E_TENANT_SLUG ?? 'va360');
    const auth = { Authorization: `Bearer ${token}` };
    const json = { ...auth, 'Content-Type': 'application/json' };

    const created = await fetch(`${BASE}/posts`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'Título original e2e', body: 'cuerpo', tags: ['general'] }),
    });
    expect(created.status, 'crear post → 2xx').toBeLessThan(300);
    const post = (await created.json()) as { id: string; editedAt: string | null };
    expect(post.editedAt).toBeNull();

    const edited = await fetch(`${BASE}/posts/${post.id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ title: 'Título EDITADO e2e' }),
    });
    expect(edited.status, 'editar → 2xx').toBeLessThan(300);
    const updated = (await edited.json()) as { title: string; editedAt: string | null };
    expect(updated.title).toBe('Título EDITADO e2e');
    expect(updated.editedAt).not.toBeNull();
  });

  test('PATCH post sin auth → 401', async () => {
    const res = await fetch(`${BASE}/posts/00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  test('unsubscribe con token inválido → 400 (público, sin auth)', async () => {
    const res = await fetch(`${BASE}/unsubscribe?token=basura`);
    expect(res.status, 'token inválido → 400').toBe(400);
    expect((res.headers.get('content-type') ?? '').includes('text/html')).toBe(true);
  });

  test('unsubscribe sin token → 400', async () => {
    const res = await fetch(`${BASE}/unsubscribe`);
    expect(res.status).toBe(400);
  });

  test('broadcast: crear (admin) encola y aparece en el listado', async () => {
    const token = await adminTokenForBootstrap(process.env.E2E_TENANT_SLUG ?? 'va360');
    const auth = { Authorization: `Bearer ${token}` };
    const json = { ...auth, 'Content-Type': 'application/json' };

    const subject = `Aviso e2e ${Date.now()}`;
    const created = await fetch(`${BASE}/broadcasts`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ subject, bodyText: 'Mensaje de prueba e2e.' }),
    });
    expect(created.status, 'crear broadcast → 2xx').toBeLessThan(300);
    const b = (await created.json()) as { id: string; status: string; subject: string };
    expect(b.subject).toBe(subject);
    expect(['PENDING', 'RUNNING', 'DONE']).toContain(b.status);

    const list = await fetch(`${BASE}/broadcasts`, { headers: auth });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<{ id: string }>;
    expect(rows.some((r) => r.id === b.id)).toBe(true);
  });

  test('broadcast sin auth → 401', async () => {
    const res = await fetch(`${BASE}/broadcasts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'x', bodyText: 'y' }),
    });
    expect(res.status).toBe(401);
  });
});
