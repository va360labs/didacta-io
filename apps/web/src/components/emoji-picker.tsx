'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

const EMOJIS = [
  '😀',
  '😊',
  '😂',
  '🤣',
  '😅',
  '😆',
  '😇',
  '🙂',
  '😉',
  '😍',
  '🤩',
  '😘',
  '😜',
  '🤔',
  '🤓',
  '😎',
  '🥺',
  '😢',
  '😭',
  '😤',
  '🤯',
  '😱',
  '🥴',
  '🥳',
  '🤗',
  '😴',
  '🫠',
  '🫡',
  '😬',
  '🙄',
  '👍',
  '👎',
  '👌',
  '🙌',
  '👏',
  '🤝',
  '🙏',
  '✊',
  '✌️',
  '🤞',
  '💪',
  '🫶',
  '👋',
  '🤟',
  '🫂',
  '💁',
  '🤷',
  '🙆',
  '🤙',
  '👊',
  '❤️',
  '🧡',
  '💛',
  '💚',
  '💙',
  '💜',
  '🖤',
  '💔',
  '❤️‍🔥',
  '💯',
  '✅',
  '❌',
  '⭐',
  '🌟',
  '💫',
  '✨',
  '🔥',
  '💥',
  '💡',
  '🎯',
  '🚀',
  '🎉',
  '🎊',
  '🎈',
  '📚',
  '💬',
  '📌',
  '🔔',
  '🏆',
  '🎓',
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const t = useTranslations('comunidadComponentes');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('emojiPickerAria')}
      className="absolute bottom-full left-0 mb-2 z-30 rounded-xl border border-[#E2E8F0] bg-white shadow-lg p-2 w-[272px]"
    >
      <div className="grid grid-cols-10 gap-0.5">
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={emoji}
            onClick={() => {
              onSelect(emoji);
              onClose();
            }}
            className="h-7 w-7 flex items-center justify-center rounded text-lg hover:bg-[#F1F5F9] transition-colors leading-none"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
