import { useEffect, useRef, useState } from 'react';
import { BATCH_LIMIT_FILES, BATCH_LIMIT_MB } from '../../lib/ingestLimits';

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
    // tests assume the fallback-notice branch by default.
    const supported = 'webkitdirectory' in HTMLInputElement.prototype;
    if (supported) {
      // CRITICAL (UI-SPEC §13.7): set via DOM API, NOT JSX prop. React 18+
      // warns on unknown DOM properties; webkitdirectory is non-standard
      input.setAttribute('webkitdirectory', '');
    }
    setFolderSupported(supported);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    onSelect(Array.from(fileList));
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
        aria-label="Drop Markdown, text, or Word files, or a ZIP, or choose files"
        aria-describedby="import-dropzone-helper"
        className={[
          'w-full mt-6 border-2 border-dashed rounded-md p-8 text-center transition-colors cursor-pointer disabled:cursor-not-allowed',
          dragActive
            ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5 text-ink'
            : ' border-line-strong text-ink-muted hover:border-line-strong',
        ].join(' ')}
      >
        <p className="text-sm">
          Drop .md, .markdown, .txt or .docx files, a folder, or a .zip here.
        </p>
        <p
          id="import-dropzone-helper"
          className="text-xs text-ink-muted mt-1 leading-[1.4]"
        >
          Up to {BATCH_LIMIT_FILES} files · {BATCH_LIMIT_MB} MB compressed.
        </p>
      </button>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => markdownInputRef.current?.click()}
          disabled={disabled}
          className="px-3 py-1.5 text-sm rounded-md border border-line-strong disabled:opacity-50"
        >
          Choose files
        </button>
        <button
          type="button"
          onClick={() => folderInputRef.current?.click()}
          disabled={disabled || !folderSupported}
          className="px-3 py-1.5 text-sm rounded-md border border-line-strong disabled:opacity-50"
        >
          Choose folder
        </button>
        <button
          type="button"
          onClick={() => zipInputRef.current?.click()}
          disabled={disabled}
          className="px-3 py-1.5 text-sm rounded-md border border-line-strong disabled:opacity-50"
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
        accept=".md,.markdown,.txt,.docx,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        multiple
        aria-label="Choose files"
        onChange={handleChange}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        accept=".md,.markdown,.txt,.docx,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
