'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon, type IconName } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  COMMUNITY_TAG_ICONS,
  communityApi,
  type CommunityTag,
  type CommunityTagIcon,
} from '@/lib/community';

/**
 * Paleta sugerida para que el admin no tenga que tipear hex a mano.
 * Coincide con la paleta de marca + 3 acentos cálidos.
 */
const SUGGESTED_COLORS = [
  '#1E5AA8', // Azul confianza
  '#18B5A8', // Teal acento
  '#0D1B2A', // Noche
  '#2E7DCE', // Azul info
  '#16A34A', // Verde éxito
  '#F59E0B', // Ámbar
  '#FF6F61', // Coral
  '#7C3AED', // Violeta
];

interface FormState {
  name: string;
  color: string;
  icon: CommunityTagIcon | '';
}

const EMPTY_FORM: FormState = { name: '', color: SUGGESTED_COLORS[0]!, icon: '' };

export default function CommunityTagsAdminPage() {
  const [tags, setTags] = useState<CommunityTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<CommunityTag | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Solo super_admin/tenant_admin pueden gestionar. El backend ya
  // rechaza cualquier acción no autorizada — esta verificación es
  // sólo para mostrar el mensaje correcto en lugar de un 403.
  const roles = useMemo(() => authStorage.getSession()?.user.roles ?? [], []);
  const canManage = roles.includes('super_admin') || roles.includes('tenant_admin');

  async function reload() {
    try {
      setTags(await communityApi.listTags());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los tags.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function startEdit(tag: CommunityTag) {
    setEditing(tag);
    setForm({
      name: tag.name,
      color: tag.color,
      icon: (tag.icon as CommunityTagIcon | null) ?? '',
    });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        color: form.color,
        icon: form.icon === '' ? null : form.icon,
      };
      if (editing) {
        await communityApi.updateTag(editing.id, payload);
      } else {
        await communityApi.createTag(payload);
      }
      cancelEdit();
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos guardar el tag.');
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(tag: CommunityTag) {
    if (!window.confirm(`¿Eliminar el tag "${tag.name}"?`)) return;
    setPending(true);
    setError(null);
    try {
      await communityApi.deleteTag(tag.id);
      if (editing?.id === tag.id) cancelEdit();
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos eliminar el tag.');
    } finally {
      setPending(false);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">
          Solo los administradores del tenant pueden gestionar los tags de comunidad.
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Tags de comunidad</h1>
        <p className="mt-1 max-w-2xl text-text-muted">
          Curá los tags oficiales del tenant con color e icono. Los autores siguen pudiendo escribir
          tags libres en sus posts; los curados acá se pintan con el estilo configurado en el feed y
          la sidebar.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Tags existentes</CardTitle>
            <CardDescription>
              {tags === null
                ? 'Cargando…'
                : tags.length === 0
                  ? 'Aún no hay tags. Creá el primero en el formulario de la derecha.'
                  : `${tags.length} tag${tags.length === 1 ? '' : 's'} curado${tags.length === 1 ? '' : 's'}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tags === null ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-12 w-full" />
                ))}
              </div>
            ) : tags.length === 0 ? null : (
              <ul className="divide-y divide-border-soft">
                {tags.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-3">
                    <TagPreview tag={t} />
                    <span className="font-mono text-xs text-text-subtle">{t.color}</span>
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(t)}
                        disabled={pending}
                      >
                        Editar
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleDelete(t)}
                        disabled={pending}
                        className="text-danger-700 hover:bg-danger-50"
                      >
                        Eliminar
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{editing ? `Editar "${editing.name}"` : 'Nuevo tag'}</CardTitle>
            <CardDescription>
              {editing
                ? 'Modificá el nombre, color o icono. El cambio impacta a todos los posts que usen este tag.'
                : 'Creá un tag oficial. El nombre se normaliza a minúsculas para evitar duplicados.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="tag-name">Nombre</Label>
                <Input
                  id="tag-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  minLength={1}
                  maxLength={40}
                  placeholder="ayuda, anuncios, ideas..."
                />
              </div>

              <div className="space-y-2">
                <Label>Color</Label>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, color: c }))}
                      aria-label={`Color ${c}`}
                      aria-pressed={form.color === c}
                      className={
                        form.color === c
                          ? 'h-8 w-8 rounded-md ring-2 ring-brand-500 ring-offset-2 ring-offset-bg'
                          : 'h-8 w-8 rounded-md ring-1 ring-border'
                      }
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <Input
                  type="text"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                  pattern="^#[0-9a-fA-F]{6}$"
                  required
                  placeholder="#1E5AA8"
                  className="font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tag-icon">Icono</Label>
                <Select
                  id="tag-icon"
                  value={form.icon}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, icon: e.target.value as FormState['icon'] }))
                  }
                >
                  <option value="">Sin icono</option>
                  {COMMUNITY_TAG_ICONS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="rounded-md border border-border-soft bg-surface-2 p-3">
                <p className="text-xs text-text-subtle">Vista previa</p>
                <div className="mt-2">
                  <TagPreview
                    tag={{
                      id: 'preview',
                      tenantId: '',
                      name: form.name || 'tu-tag',
                      color: form.color,
                      icon: form.icon || null,
                      createdAt: '',
                      updatedAt: '',
                    }}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
                {editing ? (
                  <Button type="button" variant="ghost" onClick={cancelEdit} disabled={pending}>
                    Cancelar
                  </Button>
                ) : null}
                <Button type="submit" disabled={pending || form.name.trim().length === 0}>
                  {pending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear tag'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

/**
 * Preview del chip tal cual se renderiza en el feed: fondo con el color
 * a opacidad baja + texto sólido. Si hay icono, va a la izquierda.
 */
function TagPreview({ tag }: { tag: CommunityTag }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        // Mezclar con el color base del surface para que el chip respete
        // el theme (light/dark). 18% de opacidad da contraste razonable
        // sin dominar la card.
        backgroundColor: `${tag.color}2E`,
        color: tag.color,
      }}
    >
      {tag.icon ? <Icon name={tag.icon as IconName} size={14} /> : null}
      {tag.name}
    </span>
  );
}
