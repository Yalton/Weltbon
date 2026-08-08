import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';
import { getAccessToken } from '../api/client';

type Format = 'json' | 'markdown' | 'pdf' | 'docx';

interface FormatItem {
  format: Format;
  label: string;
  hint?: string;
  fallbackExt: string;
}

const FORMAT_ITEMS: FormatItem[] = [
  { format: 'json',     label: 'JSON',         hint: 'Universe data (round-trip)', fallbackExt: 'json' },
  { format: 'markdown', label: 'Markdown ZIP', hint: 'Obsidian-compatible',        fallbackExt: 'zip' },
  { format: 'pdf',      label: 'PDF',          hint: 'Title page + TOC',           fallbackExt: 'pdf' },
  { format: 'docx',     label: 'DOCX',         hint: 'Word / Google Docs',         fallbackExt: 'docx' },
];

interface Props {
  universeId: string;
  /** Used if Content-Disposition is missing/malformed (e.g. universe.name from caller). */
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
      // over the generic message — but the body may be absent, empty, or
      // non-JSON (a plain-text error page), so parse it defensively and never
      // let a parse failure replace one confusing failure with another.
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
          className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5 inline-flex items-center gap-1"
        >
          Export
          <span aria-hidden>↓</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="min-w-[220px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-1 shadow-lg z-50 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
        >
          {FORMAT_ITEMS.map((item) => {
            const isLoading = !!loading[item.format];
            return (
              <DropdownMenu.Item
                key={item.format}
                disabled={isLoading}
                onSelect={(e) => {
                  // Keep menu open during async export; user dismisses manually.
                  e.preventDefault();
                  void exportFormat(item.format);
                }}
                className="px-3 py-2 text-sm rounded-sm cursor-pointer outline-none hover:bg-neutral-100 dark:hover:bg-neutral-800 data-[disabled]:opacity-50"
              >
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <span className="font-medium">
                      {isLoading ? `Exporting ${item.label}…` : item.label}
                    </span>
                    {item.hint ? (
                      <span className="block text-xs text-neutral-500">{item.hint}</span>
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
      className="inline-block w-3 h-3 border-2 border-neutral-300 border-t-neutral-700 rounded-full animate-spin"
      aria-label="loading"
    />
  );
}

function parseContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // Match: attachment; filename="universe-2026-04-25.zip"  OR  attachment; filename=universe-2026-04-25.zip
  const m = header.match(/filename\*?=(?:"([^"]+)"|([^;]+))/i);
  const raw = m?.[1] ?? m?.[2];
  return raw ? raw.trim() : null;
}
