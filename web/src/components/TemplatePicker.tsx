import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router-dom';
import { TEMPLATES, type EntryTemplate } from '../lib/entryTemplates';
import { useTemplates, useCloneDefaultTemplate } from '../hooks/useTemplates';
import { Toast } from './Toast';

export function TemplatePicker({
  open,
  onOpenChange,
  universeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
}) {
  const navigate = useNavigate();
  const userTemplatesQuery = useTemplates();
  const cloneMutation = useCloneDefaultTemplate();
  const [toast, setToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(null);

  const handleSelectDefault = (template: EntryTemplate) => {
    // Default cards: navigate with template but NO templateId (D-16 — kebab ids are not UUIDs)
    navigate(`/universes/${universeId}/entries/new`, { state: { template } });
    onOpenChange(false);
  };

  const handleSelectPersonal = (userTemplate: {
    id: string;
    name: string;
    entryType: string;
    summary: string;
    body: string;
    meta: Array<{ name: string; default_value: string }>;
  }) => {
    // Personal cards: build an EntryTemplate-shaped object from the UserTemplate
    // and include templateId (the Postgres UUID) for D-16 last_used_at stamp
    const template: EntryTemplate = {
      id: userTemplate.id,
      label: userTemplate.name,
      entryType: userTemplate.entryType,
      summary: userTemplate.summary,
      body: userTemplate.body,
      meta: userTemplate.meta,
    };
    navigate(`/universes/${universeId}/entries/new`, {
      state: { template, templateId: userTemplate.id },
    });
    onOpenChange(false);
  };

  const handleClone = async (e: React.MouseEvent, templateId: string) => {
    e.stopPropagation();
    try {
      await cloneMutation.mutateAsync(templateId);
      setToast({ message: 'Cloned to your templates.', variant: 'success' });
    } catch {
      setToast({ message: "Couldn't clone the template. Try again.", variant: 'error' });
    }
  };

  const userTemplates = userTemplatesQuery.data ?? [];

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
          <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl max-h-[80vh] overflow-y-auto bg-panel rounded-md p-6 z-50 border border-line data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
            <Dialog.Title className="text-xl font-semibold">
              Start a new entry
            </Dialog.Title>
            <Dialog.Description className="text-sm text-ink-muted mt-1">
              Pick a template to prefill structure, or start with a blank entry.
            </Dialog.Description>

            <div className="mt-6">
              {/* Section 1: Empty entry — top, full-width, dashed border */}
              <button
                type="button"
                onClick={() => {
                  navigate(`/universes/${universeId}/entries/new`);
                  onOpenChange(false);
                }}
                className="w-full text-left rounded-md border border-dashed border-line-strong p-3 hover:border-[color:var(--color-accent)] transition-colors"
              >
                <div className="font-medium">Empty entry</div>
                <div className="text-xs text-ink-muted mt-0.5">Start with no scaffold.</div>
              </button>

              {/* Section 2: Default templates */}
              <h3 className="text-xs uppercase tracking-wide text-ink-muted mb-2 mt-6">
                Default templates
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {TEMPLATES.map((t) => (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectDefault(t)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectDefault(t);
                      }
                    }}
                    className="group relative text-left rounded-md border border-line p-3 hover:border-[color:var(--color-accent)] transition-colors cursor-pointer"
                  >
                    {/* Card header row: label + Default badge */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium">{t.label}</div>
                      <span className="shrink-0 bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] text-xs uppercase tracking-wide font-medium px-1.5 py-0.5 rounded-sm">
                        Default
                      </span>
                    </div>
                    <div className="text-xs text-ink-muted mt-0.5">
                      Type: {t.entryType}
                    </div>
                    {/* Clone-to-personal affordance — visible on hover/focus-within */}
                    <div className="flex justify-end mt-2">
                      <button
                        type="button"
                        onClick={(e) => handleClone(e, t.id)}
                        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-xs text-[color:var(--color-accent)] hover:underline"
                      >
                        Clone to personal
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Section 3: Your templates — only rendered when user has personal templates */}
              {userTemplatesQuery.isPending && (
                <>
                  <p className="text-xs uppercase tracking-wide text-ink-muted mb-2 mt-8">
                    Your templates
                  </p>
                  <div className="space-y-2" aria-busy="true" aria-label="Loading your templates">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="h-12 rounded-md bg-raised animate-pulse"
                      />
                    ))}
                  </div>
                </>
              )}

              {!userTemplatesQuery.isPending && userTemplates.length > 0 && (
                <>
                  <h3 className="text-xs uppercase tracking-wide text-ink-muted mb-2 mt-8">
                    Your templates
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    {userTemplates.map((ut) => (
                      <button
                        key={ut.id}
                        type="button"
                        onClick={() => handleSelectPersonal(ut)}
                        className="text-left rounded-md border border-line p-3 hover:border-[color:var(--color-accent)] transition-colors"
                      >
                        <div className="font-medium">{ut.name}</div>
                        <div className="text-xs text-ink-muted mt-0.5">
                          Type: {ut.entryType}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          onDismiss={() => setToast(null)}
        />
      )}
    </>
  );
}
