'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { accessGroupsApi, type AccessGroupListItem } from '@/lib/access-groups';
import { ApiHttpError } from '@/lib/api-client';
import {
  adminUsersApi,
  parseBulkInviteCsv,
  ROLE_LABELS,
  type AssignableRole,
  type BulkInviteRow,
  type BulkInviteState,
} from '@/lib/admin-users';
import { authStorage } from '@/lib/auth-storage';

/// Mismo tope que el backend (`bulkInviteSchema.rows.max(300)`): un CSV más
/// grande hay que partirlo en dos subidas.
const MAX_ROWS = 300;
const POLL_MS = 1500;

export default function ImportarUsuariosPage() {
  const [role, setRole] = useState<AssignableRole>('alumno');
  const [groupId, setGroupId] = useState('');
  const [groups, setGroups] = useState<AccessGroupListItem[] | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<BulkInviteRow[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estado, setEstado] = useState<BulkInviteState | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let aborted = false;
    const token = authStorage.getAccessToken();
    if (!token) return;
    accessGroupsApi
      .list(token)
      .then((r) => {
        if (!aborted && r.groups.length > 0) setGroups(r.groups);
      })
      .catch(() => undefined);
    return () => {
      aborted = true;
    };
  }, []);

  // Al entrar: si ya hay una importación en curso (el admin recargó la
  // página o volvió después), retoma el seguimiento en vez de mostrar el
  // formulario de subida otra vez.
  useEffect(() => {
    const token = authStorage.getAccessToken();
    if (!token) return;
    adminUsersApi
      .bulkInviteStatus(token)
      .then((s) => {
        if (s?.enCurso) setEstado(s);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!estado?.enCurso) return;
    const token = authStorage.getAccessToken();
    if (!token) return;
    const id = window.setInterval(() => {
      adminUsersApi
        .bulkInviteStatus(token)
        .then((s) => setEstado(s))
        .catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [estado?.enCurso]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reseteamos el input para poder re-seleccionar el mismo archivo.
    e.target.value = '';
    if (!file) return;

    setParseError(null);
    setRows(null);
    setFileName(file.name);

    try {
      const text = await readFileAsText(file);
      const parsed = parseBulkInviteCsv(text);
      if (parsed.length === 0) {
        setParseError('No encontramos filas con un email válido (revisá la columna "email").');
        return;
      }
      if (parsed.length > MAX_ROWS) {
        setParseError(
          `El archivo trae ${parsed.length} filas y el máximo por subida es ${MAX_ROWS}. Partilo en varios CSV.`,
        );
        return;
      }
      setRows(parsed);
    } catch {
      setParseError('No pudimos leer el archivo.');
    }
  }

  async function handleConfirm() {
    if (!rows) return;
    const token = authStorage.getAccessToken();
    if (!token) {
      setError('Tu sesión expiró.');
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const res = await adminUsersApi.startBulkInvite(token, {
        rows,
        role,
        accessGroupId: groupId || undefined,
      });
      if (res.yaEnCurso) {
        setError('Ya hay una importación en curso; esperá a que termine.');
      }
      const s = await adminUsersApi.bulkInviteStatus(token);
      setEstado(s);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos arrancar la importación.');
    } finally {
      setStarting(false);
    }
  }

  function resetForm() {
    setRows(null);
    setFileName(null);
    setParseError(null);
    setEstado(null);
    setError(null);
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href="/admin/usuarios">← Volver al listado</Link>
      </Button>

      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">Importar CSV</h1>
        <p className="mt-1 text-text-muted">
          Da de alta a varias personas a la vez. A todas se les asigna el mismo rol y (si elegís
          uno) el mismo grupo de acceso; cada una recibe su propio email para definir contraseña.
        </p>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="file" size={18} />
            </span>
            <div className="min-w-0">
              <CardTitle>Archivo y datos comunes</CardTitle>
              <CardDescription>
                El CSV necesita una columna <code>email</code> (o <code>correo</code>); una columna{' '}
                <code>name</code>/<code>nombre</code> es opcional. Filas sin email válido se
                ignoran.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="role">
              Rol para todos <span className="text-danger-700">*</span>
            </Label>
            <Select
              id="role"
              value={role}
              onChange={(e) => setRole(e.target.value as AssignableRole)}
              disabled={!!estado?.enCurso}
            >
              {Object.entries(ROLE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          {groups ? (
            <div className="space-y-2">
              <Label htmlFor="accessGroup">Grupo de acceso para todos (opcional)</Label>
              <Select
                id="accessGroup"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                disabled={!!estado?.enCurso}
                data-testid="bulk-invite-group-select"
              >
                <option value="">Sin grupo</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-text-subtle">
                Todas las personas del CSV quedan matriculadas en los cursos de este grupo.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label>Archivo CSV</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => void handleFile(e)}
            />
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={!!estado?.enCurso}
              >
                Elegir archivo
              </Button>
              {fileName ? <span className="text-sm text-text-muted">{fileName}</span> : null}
            </div>
          </div>

          {parseError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {parseError}
            </div>
          ) : null}

          {rows && !estado ? (
            <div className="rounded-lg border border-border bg-bg-subtle p-3 text-sm text-text-muted">
              Encontramos <strong className="text-text">{rows.length}</strong> persona
              {rows.length === 1 ? '' : 's'} válida{rows.length === 1 ? '' : 's'} en el archivo.
            </div>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}

          {estado ? (
            <div className="rounded-lg border border-border bg-bg-subtle p-4 text-sm">
              <p className="font-semibold text-text">
                {estado.enCurso
                  ? `Importando… ${estado.creados} de ${estado.total}`
                  : `Importados ${estado.creados} de ${estado.total}`}
                {estado.fallidos.length > 0 ? ` · ${estado.fallidos.length} fallaron` : ''}
              </p>
              {estado.enCurso ? (
                <>
                  <div
                    className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border"
                    role="progressbar"
                    aria-valuenow={estado.creados}
                    aria-valuemin={0}
                    aria-valuemax={estado.total}
                  >
                    <div
                      className="h-full bg-brand-500 transition-all"
                      style={{
                        width: `${estado.total > 0 ? (estado.creados / estado.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <p className="mt-2 text-text-muted">
                    Va de una en una. Sigue en el servidor: podés cerrar esta página sin cortarlo.
                  </p>
                </>
              ) : null}
              {estado.fallidos.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {estado.fallidos.slice(0, 10).map((f) => (
                    <li key={f.email} className="text-danger-700">
                      {f.email} — {f.error}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-3 border-t border-border-soft pt-4">
            {estado && !estado.enCurso ? (
              <>
                <Button type="button" variant="ghost" onClick={resetForm}>
                  Importar otro archivo
                </Button>
                <Button asChild>
                  <Link href="/admin/usuarios">Ir al listado</Link>
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={handleConfirm}
                disabled={!rows || starting || !!estado?.enCurso}
              >
                {starting
                  ? 'Arrancando…'
                  : estado?.enCurso
                    ? 'Importando…'
                    : `Importar ${rows?.length ?? ''} persona${rows?.length === 1 ? '' : 's'}`}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Lee un File como texto (UTF-8) con la API FileReader del navegador. */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('No pudimos leer el archivo.'));
    reader.readAsText(file);
  });
}
