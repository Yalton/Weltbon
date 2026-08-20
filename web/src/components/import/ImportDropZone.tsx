import { useEffect, useRef, useState } from 'react';
import { BATCH_LIMIT_FILES, BATCH_LIMIT_MB } from '../../lib/ingestLimits';

/**
 * Drop-zone widget for the Phase 12 import flow.
 *
 * Two responsibilities:
 *   1. Render a drag-and-drop target plus explicit Markdown-file, folder, and
 *      ZIP pickers. Keeping these as separate inputs is important: applying
 *      `webkitdirectory` to the ordinary file picker makes supported browsers
 *      refuse standalone files.
 *   2. Feature-detect `webkitdirectory` and apply it to the folder input via
 *      DOM ref API (NOT
 *      a JSX prop) per UI-SPEC §13.7. React 18+ warns on unknown DOM
 *      properties; webkitdirectory is non-standard, so setting it after
 *      mount via ref.setAttribute() bypasses React's prop reconciliation
 *      entirely. When unsupported (Firefox, older Safari), an inline amber
 *      fallback notice tells the user to ZIP their folder instead.
 *
 * Pure presentational — calls `onSelect(files)` when the user picks via
 * file dialog or drag-and-drop. The parent owns the upload state machine
 * and any validation; this component does NOT inspect file contents.
 *
 * The `fallbackHint` prop is reserved for the parent to override the auto
 * fallback notice text in future plans; today it is unused (folder-support
 * detection happens locally so the parent doesn't need to thread it
 * through).
 */
interface ImportDropZoneProps {
  onSelect: (files: File[]) => void;
  disabled: boolean;
  fallbackHint?: string;
}

export function ImportDropZone({ onSelect, disabled }: ImportDropZoneProps) {
  const markdownInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [folderSupported, setFolderSupported] = useState(false);

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    // Feature-detect: webkitdirectory presence on the prototype chain.
    // Chromium-based browsers (Chrome, Edge, Brave) AND Safari 14.4+ expose
    // this property; Firefox does NOT. jsdom does not expose it either, so
    // tests assume the fallback-notice branch by default.
    const supported = 'webkitdirectory' in HTMLInputElement.prototype;
    if (supported) {
      // CRITICAL (UI-SPEC §13.7): set via DOM API, NOT JSX prop. React 18+
      // warns on unknown DOM properties; webkitdirectory is non-standard
      // and would emit "Unknown DOM property webkitdirectory. Did you mean
      // webkitDirectory?". Setting via setAttribute() after mount bypasses
      // React's prop reconciliation entirely.
      input.setAttribute('webkitdirectory', '');
    }
    setFolderSupported(supported);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    onSelect(Array.from(fileList));
    // Reset the input so picking the same folder twice in a row still
    // triggers onChange. Without this, change does not fire on identical
    // re-selection (e.g., to retry after an error).
    e.currentTarget.value = '';
  };

  const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (!disabled) setDragActive(true);
  };

  const handleDragLeave = () => setDragActive(false);

  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (disabled) return;
    const dropped = e.dataTransfer.files;
    if (!dropped || dropped.length === 0) return;
    onSelect(Array.from(dropped));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!disabled) markdownInputRef.current?.click();
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        disabled={disabled}
        aria-label="Drop Markdown files or a ZIP, or choose Markdown files"
        aria-describedby="import-dropzone-helper"
        className={[
          'w-full mt-6 border-2 border-dashed rounded-md p-8 text-center transition-colors cursor-pointer disabled:cursor-not-allowed',
          dragActive
            ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5 text-neutral-700 dark:text-neutral-200'
            : 'border-neutral-300 dark:border-neutral-700 text-neutral-400 hover:border-neutral-400 dark:hover:border-neutral-600',
        ].join(' ')}
      >
        <p className="text-sm">
          Drop .md files, a folder, or a .zip here.
        </p>
        <p
          id="import-dropzone-helper"
          className="text-xs text-neutral-500 mt-1 leading-[1.4]"
        >
          Up to {BATCH_LIMIT_FILES} files · {BATCH_LIMIT_MB} MB compressed.
        </p>
      </button>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => markdownInputRef.current?.click()}
          disabled={disabled}
          className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
        >
          Choose Markdown files
        </button>
        <button
          type="button"
          onClick={() => folderInputRef.current?.click()}
          disabled={disabled || !folderSupported}
          className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
        >
          Choose folder
        </button>
        <button
          type="button"
          onClick={() => zipInputRef.current?.click()}
          disabled={disabled}
          className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
        >
          Choose ZIP
        </button>
      </div>
      {!folderSupported && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400 leading-[1.4]">
          Folder upload works in Chrome, Edge, and Safari 14.4+. In other
          browsers, please ZIP your folder and upload that.
        </p>
      )}
      <input
        ref={markdownInputRef}
        type="file"
        accept=".md,.markdown,text/markdown"
        multiple
        aria-label="Choose Markdown files"
        onChange={handleChange}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        accept=".md,.markdown,text/markdown"
        multiple
        aria-label="Choose folder"
        onChange={handleChange}
        className="hidden"
      />
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        aria-label="Choose ZIP"
        onChange={handleChange}
        className="hidden"
      />
    </>
  );
}
