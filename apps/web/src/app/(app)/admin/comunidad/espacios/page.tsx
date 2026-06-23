'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon, type IconName } from '@/components/icon';
import { SpaceIcon, isIconName } from '@/components/space-icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  COMMUNITY_SPACE_ICONS,
  communityApi,
  invalidateCommunitySpacesCache,
  type CommunitySpace,
} from '@/modules/community';

type IconMode = 'icon' | 'emoji';

const SUGGESTED_COLORS = [
  '#1E5AA8',
  '#18B5A8',
  '#0D1B2A',
  '#2E7DCE',
  '#16A34A',
  '#F59E0B',
  '#FF6F61',
  '#7C3AED',
];

interface FormState {
  slug: string;
  title: string;
  description: string;
  icon: string;
  color: string;
  sortOrder: string;
}

const EMPTY_FORM: FormState = {
  slug: '',
  title: '',
  description: '',
  icon: 'hash',
  color: SUGGESTED_COLORS[0]!,
  sortOrder: '0',
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function EspaciosAdminPage() {
  const [spaces, setSpaces] = useState<CommunitySpace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<CommunitySpace | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [iconMode, setIconMode] = useState<IconMode>('icon');

  const roles = useMemo(() => authStorage.getSession()?.user.roles ?? [], []);
  const canManage = roles.includes('super_admin') || roles.includes('tenant_admin');

  async function reload() {
    try {
      setSpaces(await communityApi.listSpaces());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los espacios.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function startEdit(space: CommunitySpace) {
    setEditing(space);
    setIconMode(isIconName(space.icon) ? 'icon' : 'emoji');
    setForm({
      slug: space.slug,
      title: space.title,
      description: space.description ?? '',
      icon: space.icon,
      color: space.color,
      sortOrder: String(space.sortOrder),
    });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setIconMode('icon');
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        icon: form.icon,
        color: form.color,
        sortOrder: Number(form.sortOrder) || 0,
      };
      if (editing) {
        await communityApi.updateSpace(editing.slug, payload);
      } else {
        await communityApi.createSpace({ slug: form.slug.trim(), ...payload });
      }
      invalidateCommunitySpacesCache();
      cancelEdit();
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos guardar el espacio.');
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(space: CommunitySpace) {
    if (!window.confirm(`¿Eliminar el espacio "${space.title}"? Esta acción no se puede deshacer.`))
      return;
    setPending(true);
    setError(null);
    try {
      await communityApi.deleteSpace(space.slug);
      invalidateCommunitySpacesCache();
      if (editing?.slug === space.slug) cancelEdit();
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos eliminar el espacio.');
    } finally {
      setPending(false);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">
          Solo los administradores del tenant pueden gestionar los espacios de comunidad.
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Espacios de comunidad</h1>
        <p className="mt-1 max-w-2xl text-text-muted">
          Crea, edita y reordena los espacios que aparecen en el sidebar. Los espacios de sistema
          (marcados con 🔒) no se pueden eliminar.
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
            <CardTitle>Espacios existentes</CardTitle>
            <CardDescription>
              {spaces === null
                ? 'Cargando…'
                : spaces.length === 0
                  ? 'Aún no hay espacios. Crea el primero.'
                  : `${spaces.length} espacio${spaces.length === 1 ? '' : 's'}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {spaces === null ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-14 w-full" />
                ))}
              </div>
            ) : spaces.length === 0 ? null : (
              <ul className="divide-y divide-border-soft">
                {spaces.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 py-3">
                    <div
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                      style={{ backgroundColor: `${s.color}22` }}
                    >
                      <Icon name={s.icon as IconName} size={16} style={{ color: s.color }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        {s.title}
                        {s.isSystem ? (
                          <span
                            title="Espacio de sistema — no se puede eliminar"
                            className="text-text-subtle"
                          >
                            🔒
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-text-subtle">
                        /{s.slug} · orden {s.sortOrder}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(s)}
                        disabled={pending}
                      >
                        Editar
                      </Button>
                      {!s.isSystem ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleDelete(s)}
                          disabled={pending}
                          className="text-danger-700 hover:bg-danger-50"
                        >
                          Eliminar
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{editing ? `Editar "${editing.title}"` : 'Nuevo espacio'}</CardTitle>
            <CardDescription>
              {editing
                ? 'El slug no se puede cambiar. Modifica el resto de campos.'
                : 'Crea un nuevo espacio. El slug es permanente una vez creado.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="space-title">Nombre</Label>
                <Input
                  id="space-title"
                  value={form.title}
                  onChange={(e) => {
                    const title = e.target.value;
                    setForm((f) => ({
                      ...f,
                      title,
                      slug: editing ? f.slug : slugify(title),
                    }));
                  }}
                  required
                  minLength={1}
                  maxLength={60}
                  placeholder="Recursos compartidos"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="space-slug">Slug</Label>
                <Input
                  id="space-slug"
                  value={form.slug}
                  onChange={(e) =>
                    !editing && setForm((f) => ({ ...f, slug: slugify(e.target.value) }))
                  }
                  readOnly={!!editing}
                  required
                  minLength={1}
                  maxLength={60}
                  placeholder="recursos-compartidos"
                  className="font-mono"
                />
                {editing ? (
                  <p className="text-xs text-text-subtle">El slug no se puede modificar.</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="space-desc">Descripción (opcional)</Label>
                <Input
                  id="space-desc"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  maxLength={200}
                  placeholder="Comparte materiales y referencias útiles"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Icono</Label>
                  <div className="flex rounded-md border border-border text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setIconMode('icon');
                        setForm((f) => ({ ...f, icon: 'hash' }));
                      }}
                      className={
                        iconMode === 'icon'
                          ? 'rounded-l-md bg-surface-2 px-2.5 py-1 font-medium text-text'
                          : 'rounded-l-md px-2.5 py-1 text-text-muted hover:text-text'
                      }
                    >
                      Icono
                    </button>
                    <button
                      type="button"
                      onClick={() => setIconMode('emoji')}
                      className={
                        iconMode === 'emoji'
                          ? 'rounded-r-md bg-surface-2 px-2.5 py-1 font-medium text-text'
                          : 'rounded-r-md px-2.5 py-1 text-text-muted hover:text-text'
                      }
                    >
                      Emoji
                    </button>
                  </div>
                </div>

                {iconMode === 'icon' ? (
                  <div className="flex flex-wrap gap-1.5">
                    {COMMUNITY_SPACE_ICONS.map((i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, icon: i }))}
                        aria-label={i}
                        aria-pressed={form.icon === i}
                        className={
                          form.icon === i
                            ? 'grid h-8 w-8 place-items-center rounded-lg border-2 border-brand-500 bg-brand-50 text-brand-700'
                            : 'grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface-2 text-text-muted hover:border-border-strong hover:text-text'
                        }
                      >
                        <Icon name={i as IconName} size={15} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Input
                      value={form.icon}
                      onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                      placeholder="Pega o escribe un emoji: 🚀 📚 💡 🎯"
                      maxLength={4}
                      className="text-lg"
                    />
                    <p className="text-[11px] text-text-subtle">
                      Un solo emoji o carácter especial.
                    </p>
                  </div>
                )}

                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-2"
                  style={{ backgroundColor: `${form.color}18` }}
                >
                  <SpaceIcon icon={form.icon || 'hash'} color={form.color} size={16} />
                  <span className="text-sm font-medium" style={{ color: form.color }}>
                    {form.title || 'Vista previa'}
                  </span>
                </div>
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
                <Label htmlFor="space-order">Orden</Label>
                <Input
                  id="space-order"
                  type="number"
                  min="0"
                  value={form.sortOrder}
                  onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
                  placeholder="0"
                />
                <p className="text-xs text-text-subtle">
                  Número menor → aparece antes en el sidebar.
                </p>
              </div>

              <div className="flex justify-end gap-2 border-t border-border-soft pt-3">
                {editing ? (
                  <Button type="button" variant="ghost" onClick={cancelEdit} disabled={pending}>
                    Cancelar
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  disabled={
                    pending ||
                    form.title.trim().length === 0 ||
                    (!editing && form.slug.trim().length === 0)
                  }
                >
                  {pending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear espacio'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
