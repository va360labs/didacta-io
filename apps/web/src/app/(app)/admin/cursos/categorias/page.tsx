'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon, type IconName } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { coursesApi, type CourseCategory } from '@/lib/courses';

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

const ICON_OPTIONS = [
  'book',
  'sparkles',
  'users',
  'award',
  'shield',
  'message',
  'help',
  'package',
  'route',
  'star',
] as const;

interface FormState {
  name: string;
  color: string;
  icon: string;
}

const EMPTY_FORM: FormState = { name: '', color: SUGGESTED_COLORS[0]!, icon: '' };

export default function CourseCategoriesAdminPage() {
  const [items, setItems] = useState<CourseCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<CourseCategory | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const roles = useMemo(() => authStorage.getSession()?.user.roles ?? [], []);
  const canManage = roles.includes('super_admin') || roles.includes('tenant_admin');

  async function reload() {
    try {
      setItems(await coursesApi.listManagedCategories());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las categorías.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function startEdit(c: CourseCategory) {
    setEditing(c);
    setForm({ name: c.name, color: c.color, icon: c.icon ?? '' });
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
        await coursesApi.updateCategory(editing.id, payload);
      } else {
        await coursesApi.createCategory(payload);
      }
      cancelEdit();
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos guardar la categoría.');
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(c: CourseCategory) {
    if (
      !window.confirm(
        `¿Eliminar la categoría "${c.name}"? Los cursos que la tienen seguirán mostrando el nombre como texto plano.`,
      )
    )
      return;
    setPending(true);
    setError(null);
    try {
      await coursesApi.deleteCategory(c.id);
      if (editing?.id === c.id) cancelEdit();
      await reload();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'No pudimos eliminar la categoría.');
    } finally {
      setPending(false);
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-danger-700">
          Solo los administradores del tenant pueden gestionar categorías de cursos.
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-tight">Categorías de cursos</h1>
        <p className="mt-1 max-w-2xl text-text-muted">
          Curá las categorías oficiales del catálogo con color e icono. El builder ofrece este
          listado al formador como select; el catálogo y la card del curso pintan el chip con el
          estilo configurado.
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
            <CardTitle>Categorías existentes</CardTitle>
            <CardDescription>
              {items === null
                ? 'Cargando…'
                : items.length === 0
                  ? 'Aún no hay categorías. Creá la primera en el formulario de la derecha.'
                  : `${items.length} categoría${items.length === 1 ? '' : 's'} curada${items.length === 1 ? '' : 's'}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {items === null ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-12 w-full" />
                ))}
              </div>
            ) : items.length === 0 ? null : (
              <ul className="divide-y divide-border-soft">
                {items.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 py-3">
                    <CategoryPreview category={c} />
                    <span className="font-mono text-xs text-text-subtle">{c.color}</span>
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(c)}
                        disabled={pending}
                      >
                        Editar
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleDelete(c)}
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
            <CardTitle>{editing ? `Editar "${editing.name}"` : 'Nueva categoría'}</CardTitle>
            <CardDescription>
              {editing
                ? 'Modificá el nombre, color o icono. Los cursos que ya usan esta categoría se actualizan al instante.'
                : 'Creá una categoría oficial. El nombre es exact-match con la categoría del curso, así que mantenelo consistente.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="cat-name">Nombre</Label>
                <Input
                  id="cat-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  minLength={1}
                  maxLength={60}
                  placeholder="Tecnología, Liderazgo…"
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
                  className="font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cat-icon">Icono</Label>
                <Select
                  id="cat-icon"
                  value={form.icon}
                  onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
                >
                  <option value="">Sin icono</option>
                  {ICON_OPTIONS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="rounded-md border border-border-soft bg-surface-2 p-3">
                <p className="text-xs text-text-subtle">Vista previa</p>
                <div className="mt-2">
                  <CategoryPreview
                    category={{
                      id: 'preview',
                      tenantId: '',
                      name: form.name || 'Tu categoría',
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
                  {pending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear categoría'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function CategoryPreview({ category }: { category: CourseCategory }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        backgroundColor: `${category.color}2E`,
        color: category.color,
      }}
    >
      {category.icon ? <Icon name={category.icon as IconName} size={14} /> : null}
      {category.name}
    </span>
  );
}
