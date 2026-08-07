'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { storageApi } from '@/lib/storage';
import { cn } from '@/lib/utils';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  /** Aria-label cuando no hay <Label htmlFor> asociado por encima. */
  ariaLabel?: string;
}

/**
 * Editor WYSIWYG basado en Tiptap (MIT). Sin licencia comercial.
 * Output: HTML que el server sanitiza al guardar (descripción del curso)
 * y la UI del alumno re-sanitiza al renderizar via DOMPurify para
 * defender en profundidad.
 *
 * Toolbar mínima: bold, italic, headings (H2/H3), listas (bullet/orden),
 * blockquote, code inline, link, undo/redo.
 *
 * No incluye upload de imágenes en esta iteración: necesita el adapter
 * de storage funcionando per-tenant (G3 dejó la config persistida pero
 * el wiring runtime es follow-up). Cuando esté, se añade extension
 * Image con un onUpload que llame al endpoint de uploads.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
}: RichTextEditorProps) {
  const t = useTranslations('comunidadComponentes');
  const editor = useEditor({
    immediatelyRender: false, // SSR-safe: evita warning de Next.js
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Image.configure({
        HTMLAttributes: { class: 'rounded-md border border-border-soft' },
      }),
      Placeholder.configure({
        placeholder: placeholder ?? t('editorPlaceholder'),
        emptyEditorClass:
          'before:content-[attr(data-placeholder)] before:float-left before:text-text-subtle before:pointer-events-none',
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel ?? t('editorAria'),
        class: cn(
          'prose prose-slate max-w-none min-h-[10rem] px-3 py-2',
          'prose-headings:font-display prose-a:text-brand-700',
          'focus:outline-none',
        ),
      },
    },
    onUpdate({ editor: ed }) {
      onChange(ed.getHTML());
    },
  });

  // Sincroniza si el padre cambia el `value` desde fuera (ej. al cargar
  // datos del curso después de mount). Evita reset si el HTML coincide
  // para no resetear la posición del cursor mientras el user tipea.
  useEffect(() => {
    if (!editor) return;
    if (value === editor.getHTML()) return;
    editor.commands.setContent(value || '', { emitUpdate: false });
  }, [value, editor]);

  if (!editor) {
    return (
      <div className="rounded-md border border-border bg-surface px-3 py-6 text-sm text-text-subtle">
        {t('editorLoading')}
      </div>
    );
  }

  return (
    <div className={cn('rounded-md border border-border bg-surface', className)}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

interface ToolbarProps {
  editor: ReturnType<typeof useEditor>;
}

function Toolbar({ editor }: ToolbarProps) {
  const t = useTranslations('comunidadComponentes');
  const tErrors = useTranslations('errors');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  if (!editor) return null;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permitir re-seleccionar el mismo archivo
    if (!file || !editor) return;
    setUploading(true);
    try {
      const result = await storageApi.uploadImage(file);
      editor.chain().focus().setImage({ src: result.url, alt: file.name }).run();
    } catch (err) {
      window.alert(
        err instanceof ApiHttpError
          ? t('uploadImageErrorDetail', { message: apiErrorMessage(err, tErrors) })
          : t('uploadImageErrorRetry'),
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border-soft bg-surface-2 p-1">
      <ToolbarButton
        label={t('boldTitle')}
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <span className="font-bold">B</span>
      </ToolbarButton>
      <ToolbarButton
        label={t('italic')}
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <span className="italic">I</span>
      </ToolbarButton>
      <Separator />
      <ToolbarButton
        label={t('heading2')}
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        label={t('heading3')}
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        H3
      </ToolbarButton>
      <Separator />
      <ToolbarButton
        label={t('bulletList')}
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        •
      </ToolbarButton>
      <ToolbarButton
        label={t('orderedList')}
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1.
      </ToolbarButton>
      <ToolbarButton
        label={t('blockquote')}
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        ❝
      </ToolbarButton>
      <ToolbarButton
        label={t('inlineCode')}
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <span className="font-mono text-xs">{`<>`}</span>
      </ToolbarButton>
      <Separator />
      <ToolbarButton
        label={uploading ? t('uploading') : t('uploadImage')}
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
      >
        🖼
      </ToolbarButton>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={handleFileChange}
      />
      <Separator />
      <ToolbarButton
        label={t('insertLink')}
        active={editor.isActive('link')}
        onClick={() => {
          const previous = (editor.getAttributes('link').href as string | undefined) ?? '';
          const next = window.prompt(t('linkPromptWithRemove'), previous);
          if (next === null) return;
          if (next === '') {
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
            return;
          }
          editor.chain().focus().extendMarkRange('link').setLink({ href: next }).run();
        }}
      >
        🔗
      </ToolbarButton>
      <Separator />
      <ToolbarButton
        label={t('undo')}
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      >
        ↶
      </ToolbarButton>
      <ToolbarButton
        label={t('redo')}
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      >
        ↷
      </ToolbarButton>
    </div>
  );
}

function Separator() {
  return <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />;
}

function ToolbarButton({
  children,
  active,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded text-sm transition-colors',
        active ? 'bg-brand-100 text-brand-800' : 'text-text-muted hover:bg-surface hover:text-text',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}
