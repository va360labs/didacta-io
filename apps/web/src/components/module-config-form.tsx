'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Module Config Form — Genera formularios desde config.schema del módulo.
 *
 * El schema de configuración se define en `module.json` y describe los campos
 * que el admin puede configurar. Este componente renderiza el form completo
 * con validación y persistencia.
 *
 * Tipos soportados:
 * - string, number, boolean, url, email, secret
 * - select, multiselect
 * - textarea, json
 *
 * @see DISC-001.4 — Config Schema Form Renderer
 * @see Notion: Schema completo de module.json
 */

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConfigFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'url'
  | 'email'
  | 'secret'
  | 'select'
  | 'multiselect'
  | 'textarea'
  | 'json';

export interface SelectOption {
  value: string;
  label: string;
}

export interface ConfigFieldSchema {
  type: ConfigFieldType;
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  // String constraints
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  // Number constraints
  min?: number;
  max?: number;
  step?: number;
  // Select/Multiselect
  options?: SelectOption[];
  // Textarea
  rows?: number;
  // JSON
  schema?: Record<string, unknown>;
}

export interface ConfigSchema {
  [key: string]: ConfigFieldSchema;
}

export interface ModuleConfigFormProps {
  /** Nombre del módulo (para persistencia). */
  moduleName: string;
  /** Schema de configuración del módulo. */
  schema: ConfigSchema;
  /** Valores actuales (cargados del backend). */
  initialValues?: Record<string, unknown>;
  /** Callback al guardar exitosamente. */
  onSave?: (values: Record<string, unknown>) => void | Promise<void>;
  /** Callback on error. */
  onError?: (error: Error) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

export function ModuleConfigForm({
  moduleName,
  schema,
  initialValues = {},
  onSave,
  onError,
}: ModuleConfigFormProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    // Inicializar con defaults del schema + valores existentes
    const initial: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
      initial[key] = initialValues[key] ?? field.default ?? getDefaultForType(field.type);
    }
    return initial;
  });

  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<Set<string>>(new Set());

  const handleChange = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setTouched((prev) => new Set(prev).add(key));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setStatus('saving');
    setError(null);

    try {
      // Validar campos requeridos
      const errors: string[] = [];
      for (const [key, field] of Object.entries(schema)) {
        if (field.required && isEmpty(values[key])) {
          errors.push(`${field.label} es requerido.`);
        }
      }
      if (errors.length > 0) {
        throw new Error(errors.join(' '));
      }

      await onSave?.(values);
      setStatus('saved');
      setTouched(new Set());
    } catch (err) {
      setStatus('error');
      const message = err instanceof Error ? err.message : 'Error guardando configuración.';
      setError(message);
      onError?.(err instanceof Error ? err : new Error(message));
    }
  };

  const fields = Object.entries(schema);
  const hasChanges = touched.size > 0;

  if (fields.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Configuración</CardTitle>
          <CardDescription>Este módulo no tiene campos configurables.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuración de {moduleName}</CardTitle>
        <CardDescription>
          Ajusta los parámetros del módulo. Los campos marcados con * son obligatorios.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map(([key, field]) => (
              <ConfigField
                key={key}
                fieldKey={key}
                field={field}
                value={values[key]}
                onChange={(v) => handleChange(key, v)}
              />
            ))}
          </div>

          {error && (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          {status === 'saved' && (
            <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
              Configuración guardada correctamente.
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="submit" disabled={status === 'saving' || !hasChanges}>
              {status === 'saving' ? 'Guardando…' : 'Guardar configuración'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Field renderer
// ─────────────────────────────────────────────────────────────────────────────

interface ConfigFieldProps {
  fieldKey: string;
  field: ConfigFieldSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}

function ConfigField({ fieldKey, field, value, onChange }: ConfigFieldProps) {
  const id = `config-${fieldKey}`;
  const isRequired = field.required ?? false;
  const label = `${field.label}${isRequired ? ' *' : ''}`;

  // Determinar si ocupa ancho completo
  const isFullWidth = ['textarea', 'json', 'multiselect'].includes(field.type);

  const wrapperClass = isFullWidth ? 'sm:col-span-2' : '';

  switch (field.type) {
    case 'boolean':
      return (
        <div className={`flex items-center justify-between gap-4 ${wrapperClass}`}>
          <div>
            <Label htmlFor={id}>{field.label}</Label>
            {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
          </div>
          <Switch
            id={id}
            checked={Boolean(value)}
            onCheckedChange={(checked) => onChange(checked)}
            label={field.label}
          />
        </div>
      );

    case 'select':
      return (
        <div className={`space-y-1.5 ${wrapperClass}`}>
          <Label htmlFor={id}>{label}</Label>
          <Select value={String(value ?? '')} onValueChange={onChange}>
            <SelectTrigger id={id}>
              <SelectValue placeholder={field.placeholder ?? 'Seleccionar...'} />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
        </div>
      );

    case 'multiselect': {
      // Para multiselect usamos checkboxes
      const selectedValues = Array.isArray(value) ? value : [];
      return (
        <div className={`space-y-1.5 ${wrapperClass}`}>
          <Label>{label}</Label>
          <div className="flex flex-wrap gap-3 rounded border border-border p-3">
            {field.options?.map((opt) => {
              const isChecked = selectedValues.includes(opt.value);
              return (
                <label key={opt.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => {
                      if (e.target.checked) {
                        onChange([...selectedValues, opt.value]);
                      } else {
                        onChange(selectedValues.filter((v: string) => v !== opt.value));
                      }
                    }}
                    className="h-4 w-4 rounded border-border-strong"
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
          {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
        </div>
      );
    }

    case 'textarea':
      return (
        <div className={`space-y-1.5 ${wrapperClass}`}>
          <Label htmlFor={id}>{label}</Label>
          <Textarea
            id={id}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            rows={field.rows ?? 4}
          />
          {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
        </div>
      );

    case 'json':
      return (
        <div className={`space-y-1.5 ${wrapperClass}`}>
          <Label htmlFor={id}>{label}</Label>
          <Textarea
            id={id}
            value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {
                // Mantener el string si no es JSON válido (permite edición)
                onChange(e.target.value);
              }
            }}
            placeholder={field.placeholder ?? '{\n  \n}'}
            rows={field.rows ?? 6}
            className="font-mono text-sm"
          />
          {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
        </div>
      );

    case 'number':
      return (
        <div className={`space-y-1.5 ${wrapperClass}`}>
          <Label htmlFor={id}>{label}</Label>
          <Input
            id={id}
            type="number"
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(e) => {
              const v = e.target.value;
              onChange(v === '' ? undefined : Number(v));
            }}
            placeholder={field.placeholder}
            min={field.min}
            max={field.max}
            step={field.step}
            required={isRequired}
          />
          {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
        </div>
      );

    case 'secret':
      return (
        <div className={`space-y-1.5 ${wrapperClass}`}>
          <Label htmlFor={id}>{label}</Label>
          <Input
            id={id}
            type="password"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder ?? '••••••••'}
            autoComplete="new-password"
            required={isRequired}
          />
          {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
        </div>
      );

    case 'url':
      return (
        <div className={`space-y-1.5 ${wrapperClass}`}>
          <Label htmlFor={id}>{label}</Label>
          <Input
            id={id}
            type="url"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder ?? 'https://...'}
            required={isRequired}
          />
          {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
        </div>
      );

    case 'email':
      return (
        <div className={`space-y-1.5 ${wrapperClass}`}>
          <Label htmlFor={id}>{label}</Label>
          <Input
            id={id}
            type="email"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder ?? 'email@ejemplo.com'}
            required={isRequired}
          />
          {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
        </div>
      );

    case 'string':
    default:
      return (
        <div className={`space-y-1.5 ${wrapperClass}`}>
          <Label htmlFor={id}>{label}</Label>
          <Input
            id={id}
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            minLength={field.minLength}
            maxLength={field.maxLength}
            pattern={field.pattern}
            required={isRequired}
          />
          {field.description && <p className="text-xs text-text-muted">{field.description}</p>}
        </div>
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getDefaultForType(type: ConfigFieldType): unknown {
  switch (type) {
    case 'boolean':
      return false;
    case 'number':
      return undefined;
    case 'multiselect':
      return [];
    case 'json':
      return {};
    default:
      return '';
  }
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
