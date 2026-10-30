import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';
import { getAccessToken } from '../api/client';
import { buttonClasses } from './ui/Button';
import { Glyph } from './CategoryIcon';
import { menuContentClasses, menuItemClasses } from './ui/overlay';

type Format = 'json' | 'markdown' | 'pdf' | 'docx';

interface FormatItem {
  format: Format;
  label: string;
  hint?: string;
  fallbackExt: string;
}

const FORMAT_ITEMS: FormatItem[] = [
  { format: 'json', label: 'JSON', hint: 'Universe data (round-trip)', fallbackExt: 'json' },
  { format: 'markdown', label: 'Markdown ZIP', hint: 'Obsidian-compatible', fallbackExt: 'zip' },
  { format: 'pdf', label: 'PDF', hint: 'Title page + TOC', fallbackExt: 'pdf' },
  { format: 'docx', label: 'DOCX', hint: 'Word / Google Docs', fallbackExt: 'docx' },
];

interface Props {
  universeId: string;
  fallbackFilename: string;
  onToast: (msg: string) => void;
}

export function ExportMenu({ universeId, fallbackFilename, onToast }: Props) {
  const [loading, setLoading] = useState<Partial<Record<Format, boolean>>>({});

  async function exportFormat(format: Format) {
    setLoading((prev) => ({ ...prev, [format]: true }));
    try {
      const token = getAccessToken();
      const res = await fetch(`/api/universes/${universeId}/export?format=${format}`, {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw res;
      const blob = await res.blob();
      const item = FORMAT_ITEMS.find((i) => i.format === format)!;
      const filename =
        parseContentDisposition(res.headers.get('content-disposition')) ??
        `${fallbackFilename}.${item.fallbackExt}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ExportMenu] export failed:', err);
      // DV-14: prefer the server's named reason (e.g. the local-mode PDF 501)
      // non-JSON (a plain-text error page), so parse it defensively and never
      let message = 'Export failed. Try again.';
      if (err instanceof Response) {
        try {
          const body = (await err.json()) as { error?: unknown };
          if (typeof body.error === 'string' && body.error.trim()) message = body.error;
        } catch {
          // no body, empty body, or non-JSON — keep the generic message
        }
      }
      onToast(message);
    } finally {
      setLoading((prev) => ({ ...prev, [format]: false }));
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={buttonClasses('ghost')}
        >
          Export
          <Glyph name="chevron-down" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={`${menuContentClasses} min-w-[220px]`}
        >
          {FORMAT_ITEMS.map((item) => {
            const isLoading = !!loading[item.format];
            return (
              <DropdownMenu.Item
                key={item.format}
                disabled={isLoading}
                onSelect={(e) => {
                  e.preventDefault();
                  void exportFormat(item.format);
                }}
                className={`${menuItemClasses} py-2 data-[disabled]:opacity-50`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <span className="font-medium">
                      {isLoading ? `Exporting ${item.label}…` : item.label}
                    </span>
                    {item.hint ? (
                      <span className="block text-xs text-ink-muted">{item.hint}</span>
                    ) : null}
                  </span>
                  {isLoading ? <Spinner /> : null}
                </div>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 border-2 border-line-strong border-t-[color:var(--color-ink-muted)] rounded-full animate-spin"
      aria-label="loading"
    />
  );
}

function parseContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // Match: attachment; filename="universe-2026-04-25.zip" OR attachment; filename=universe-2026-04-25.zip
  const m = header.match(/filename\*?=(?:"([^"]+)"|([^;]+))/i);
  const raw = m?.[1] ?? m?.[2];
  return raw ? raw.trim() : null;
}
