'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import {
  fundaeCompaniesApi,
  formatCents,
  type CreateCompanyInput,
  type FundaeCompany,
  type UpdateCompanyInput,
} from '@/lib/fundae-companies';

/**
 * Vista admin de empresas bonificadas Fundae (LMS-79).
 * Lista + búsqueda + alta + edición inline de razón social/plantilla/crédito
 * + soft-delete con confirmación. El NIF no es editable: si una empresa
 * cambia de NIF hay que crear otra para preservar trazabilidad histórica
 * de grupos cerrados.
 */
export default function FundaeEmpresasPage() {
  const [companies, setCompanies] = useState<FundaeCompany[] | null>(null);
  const [search, setSearch] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<FundaeCompany | null>(null);

  async function reload(searchOverride?: string) {
    try {
      setError(null);
      const list = await fundaeCompaniesApi.list({
        search: (searchOverride ?? search).trim() || undefined,
        includeDeleted,
      });
      setCompanies(list);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las empresas.');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDeleted]);

  async function handleDelete(c: FundaeCompany) {
    if (
      !confirm(
        `¿Borrar la empresa "${c.razonSocial}" (${c.nif})?\n\n` +
          'Soft-delete: la fila se preserva para que los grupos cerrados sigan ' +
          'teniendo trazabilidad. Si tiene grupos activos, la API rechazará.',
      )
    ) {
      return;
    }
    try {
      await fundaeCompaniesApi.remove(c.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos borrar la empresa.');
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Empresas bonificadas</h1>
          <p className="mt-1 max-w-3xl text-text-muted">
            Empresas que financian formación con crédito Fundae. Cada grupo bonificable se vincula a
            una de estas (los costes y comunicaciones oficiales heredan los datos fiscales).
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setEditing(null);
            setShowForm((v) => !v);
          }}
        >
          <Icon name="plus" size={16} />
          {showForm ? 'Cerrar' : 'Nueva empresa'}
        </Button>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px] flex-1 space-y-1.5">
          <Label htmlFor="search">Buscar por NIF o razón social</Label>
          <Input
            id="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void reload();
            }}
            placeholder="Ej: A58818501 o Telefónica"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="includeDeleted" className="cursor-pointer">
            <input
              id="includeDeleted"
              type="checkbox"
              checked={includeDeleted}
              onChange={(e) => setIncludeDeleted(e.target.checked)}
              className="mr-2"
            />
            Incluir borradas
          </Label>
        </div>
        <Button type="button" variant="secondary" onClick={() => void reload()}>
          <Icon name="search" size={14} />
          Buscar
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showForm || editing ? (
        <CompanyForm
          editing={editing}
          onSaved={async () => {
            setShowForm(false);
            setEditing(null);
            await reload();
          }}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      ) : null}

      {companies === null ? (
        <div className="space-y-3">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : companies.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-2xl font-semibold">Sin empresas registradas</h3>
            <p className="max-w-md text-text-muted">
              Empieza creando la empresa bonificada que financiará el primer grupo formativo.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {companies.map((c) => (
            <Card key={c.id} className={c.deletedAt ? 'opacity-60' : undefined}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-semibold text-text">{c.nif}</code>
                    {c.deletedAt ? <Badge variant="muted">Borrada</Badge> : null}
                    {c.cccPrincipal ? <Badge variant="info">CCC {c.cccPrincipal}</Badge> : null}
                    {c.plantilla !== null ? (
                      <Badge variant="muted">{c.plantilla} empleados</Badge>
                    ) : null}
                  </div>
                  <p className="font-display text-base font-semibold leading-tight text-text">
                    {c.razonSocial}
                  </p>
                  <p className="text-sm tabular-nums text-text-muted">
                    Crédito: {formatCents(c.creditoTotalCents)} · usado{' '}
                    {formatCents(c.creditoUsadoCents)}
                    {c.creditoDisponibleCents !== null ? (
                      <>
                        {' · '}
                        <span className="font-semibold text-text">
                          disponible {formatCents(c.creditoDisponibleCents)}
                        </span>
                      </>
                    ) : null}
                  </p>
                  {c.datosContacto?.contactoEmail || c.datosContacto?.ciudad ? (
                    <p className="text-xs text-text-subtle">
                      {[c.datosContacto?.contactoNombre, c.datosContacto?.contactoEmail]
                        .filter(Boolean)
                        .join(' · ')}
                      {c.datosContacto?.ciudad ? ` · ${c.datosContacto.ciudad}` : ''}
                    </p>
                  ) : null}
                  {c.notas ? (
                    <p className="line-clamp-2 text-xs text-text-subtle">{c.notas}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!c.deletedAt ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setShowForm(false);
                          setEditing(c);
                        }}
                      >
                        <Icon name="edit" size={13} />
                        Editar
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleDelete(c)}
                      >
                        <Icon name="trash" size={13} />
                        Borrar
                      </Button>
                    </>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function CompanyForm({
  editing,
  onSaved,
  onCancel,
}: {
  editing: FundaeCompany | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = editing !== null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    setPending(true);
    setError(null);
    try {
      const creditoEur = Number(form.get('creditoEur') ?? 0);
      const plantillaRaw = form.get('plantilla')?.toString() ?? '';
      const cccRaw = form.get('cccPrincipal')?.toString().trim() ?? '';
      const datosContacto = {
        contactoNombre: form.get('contactoNombre')?.toString().trim() || undefined,
        contactoEmail: form.get('contactoEmail')?.toString().trim() || undefined,
        contactoTelefono: form.get('contactoTelefono')?.toString().trim() || undefined,
        direccion: form.get('direccion')?.toString().trim() || undefined,
        ciudad: form.get('ciudad')?.toString().trim() || undefined,
        codigoPostal: form.get('codigoPostal')?.toString().trim() || undefined,
        provincia: form.get('provincia')?.toString().trim() || undefined,
      };

      if (isEdit && editing) {
        const dto: UpdateCompanyInput = {
          razonSocial: form.get('razonSocial')?.toString().trim() || undefined,
          cccPrincipal: cccRaw || null,
          plantilla: plantillaRaw === '' ? null : Number(plantillaRaw),
          creditoTotalCents: creditoEur > 0 ? Math.round(creditoEur * 100) : null,
          datosContacto,
          notas: form.get('notas')?.toString() || null,
        };
        await fundaeCompaniesApi.update(editing.id, dto);
      } else {
        const dto: CreateCompanyInput = {
          nif: form.get('nif')?.toString() ?? '',
          razonSocial: form.get('razonSocial')?.toString().trim() ?? '',
          cccPrincipal: cccRaw || undefined,
          plantilla: plantillaRaw === '' ? undefined : Number(plantillaRaw),
          creditoTotalCents: creditoEur > 0 ? Math.round(creditoEur * 100) : undefined,
          datosContacto,
          notas: form.get('notas')?.toString() || undefined,
        };
        await fundaeCompaniesApi.create(dto);
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la empresa.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {isEdit ? `Editar ${editing!.razonSocial}` : 'Nueva empresa bonificada'}
        </CardTitle>
        <CardDescription>
          {isEdit
            ? 'El NIF no se puede modificar: si la empresa cambia de NIF, hay que crear una nueva entrada por trazabilidad histórica.'
            : 'Datos fiscales mínimos. La validación NIF acepta DNI, NIE y CIF con checksum español.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="nif">
                NIF / CIF <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="nif"
                name="nif"
                required={!isEdit}
                disabled={isEdit}
                defaultValue={editing?.nif}
                maxLength={20}
                className="font-mono uppercase"
                placeholder="A58818501"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="razonSocial">
                Razón social <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="razonSocial"
                name="razonSocial"
                required
                defaultValue={editing?.razonSocial}
                maxLength={200}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="cccPrincipal">Código Cuenta Cotización</Label>
              <Input
                id="cccPrincipal"
                name="cccPrincipal"
                defaultValue={editing?.cccPrincipal ?? ''}
                maxLength={15}
                placeholder="11 dígitos"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plantilla">Plantilla</Label>
              <Input
                id="plantilla"
                name="plantilla"
                type="number"
                min={0}
                defaultValue={editing?.plantilla ?? ''}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="creditoEur">Crédito Fundae (€)</Label>
              <Input
                id="creditoEur"
                name="creditoEur"
                type="number"
                step="0.01"
                min={0}
                defaultValue={
                  editing?.creditoTotalCents !== null && editing?.creditoTotalCents !== undefined
                    ? (editing.creditoTotalCents / 100).toFixed(2)
                    : ''
                }
                placeholder="0,00"
              />
            </div>
          </div>

          <fieldset className="space-y-3 rounded-lg border border-border-soft p-4">
            <legend className="px-1 text-sm font-semibold text-text-muted">Contacto</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="contactoNombre">Persona contacto</Label>
                <Input
                  id="contactoNombre"
                  name="contactoNombre"
                  defaultValue={editing?.datosContacto?.contactoNombre ?? ''}
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contactoEmail">Email</Label>
                <Input
                  id="contactoEmail"
                  name="contactoEmail"
                  type="email"
                  defaultValue={editing?.datosContacto?.contactoEmail ?? ''}
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contactoTelefono">Teléfono</Label>
                <Input
                  id="contactoTelefono"
                  name="contactoTelefono"
                  defaultValue={editing?.datosContacto?.contactoTelefono ?? ''}
                  maxLength={40}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="direccion">Dirección</Label>
                <Input
                  id="direccion"
                  name="direccion"
                  defaultValue={editing?.datosContacto?.direccion ?? ''}
                  maxLength={200}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ciudad">Ciudad</Label>
                <Input
                  id="ciudad"
                  name="ciudad"
                  defaultValue={editing?.datosContacto?.ciudad ?? ''}
                  maxLength={120}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="codigoPostal">CP</Label>
                <Input
                  id="codigoPostal"
                  name="codigoPostal"
                  defaultValue={editing?.datosContacto?.codigoPostal ?? ''}
                  maxLength={5}
                  pattern="\d{5}"
                />
              </div>
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="notas">Notas internas</Label>
            <Textarea
              id="notas"
              name="notas"
              rows={2}
              maxLength={2000}
              defaultValue={editing?.notas ?? ''}
            />
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}

          <div className="flex items-center gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={pending}>
              {pending ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Crear empresa'}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
