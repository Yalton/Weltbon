import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router-dom';
import { TEMPLATE_GROUPS, type EntryTemplate } from '../lib/entryTemplates';

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

  const handleSelect = (template: EntryTemplate) => {
    if (template.id === 'blank') {
      navigate(`/universes/${universeId}/entries/new`);
    } else {
      navigate(`/universes/${universeId}/entries/new`, { state: { template } });
    }
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl max-h-[80vh] overflow-y-auto bg-white dark:bg-neutral-900 rounded-md p-6 z-50 border border-neutral-200 dark:border-neutral-800">
          <Dialog.Title className="text-xl font-semibold">
            Start a new entry
          </Dialog.Title>
          <Dialog.Description className="text-sm text-neutral-500 mt-1">
            Pick a template to pre-fill structure, or start with a blank entry.
          </Dialog.Description>

          <div className="mt-6 space-y-6">
            {TEMPLATE_GROUPS.map((group) => (
              <section key={group.label}>
                <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
                  {group.label}
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {group.templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => handleSelect(t)}
                      className={[
                        'text-left rounded-md border p-3 hover:border-[color:var(--color-accent)] transition-colors',
                        t.id === 'blank'
                          ? 'border-dashed border-neutral-300 dark:border-neutral-700'
                          : 'border-neutral-200 dark:border-neutral-800',
                      ].join(' ')}
                    >
                      <div className="font-medium">{t.label}</div>
                      {t.entryType && (
                        <div className="text-xs text-neutral-500 mt-0.5">
                          type: {t.entryType}
                        </div>
                      )}
                      {t.description && (
                        <div className="text-xs text-neutral-500 mt-1">
                          {t.description}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
