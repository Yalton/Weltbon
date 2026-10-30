import { useState, type KeyboardEvent } from 'react';
import { TagInput } from './TagInput';
import { DICTIONARY_TERMS } from './dictionaryTerms';
import type { DictionaryWord, CreateWordInput } from '../hooks/useDictionary';


type DraftWord = {
  word: string;
  ipa: string;
  partOfSpeech: string;
  gloss: string;
  etymology: string;
  tags: string[];
};

interface Props {
  word?: DictionaryWord | null;
  isSaving?: boolean;
  onSave: (draft: CreateWordInput) => void | Promise<void>;
  onDiscard: () => void;
  languageEntryId: string | null;
}


export function DictionaryRowEditor({
  word,
  isSaving = false,
  onSave,
  onDiscard,
  languageEntryId,
}: Props) {
  const [draft, setDraft] = useState<DraftWord>({
    word: word?.word ?? '',
    ipa: word?.ipa ?? '',
    partOfSpeech: word?.partOfSpeech ?? '',
    gloss: word?.gloss ?? '',
    etymology: word?.etymology ?? '',
    tags: word?.tags ?? [],
  });

  const inputClass =
    'w-full rounded-md border border-line-strong bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed';

  async function handleSave() {
    if (!draft.word.trim() || !draft.gloss.trim()) return;
    await onSave({
      word: draft.word.trim(),
      ipa: draft.ipa,
      partOfSpeech: draft.partOfSpeech,
      gloss: draft.gloss.trim(),
      etymology: draft.etymology,
      tags: draft.tags,
      languageEntryId,
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSave();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onDiscard();
    }
  }

  function handleTextareaKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDiscard();
    }
  }

  return (
    <tr
      className="border-b border-line last:border-0"
      style={{ minHeight: '44px' }} // UI-SPEC: 44px touch target minimum (WCAG 2.5.5)
    >
      {/* Word */}
      <td className="py-3 pr-2">
        <input
          type="text"
          value={draft.word}
          onChange={(e) => setDraft({ ...draft, word: e.target.value })}
          onKeyDown={handleKeyDown}
          disabled={isSaving}
          placeholder="word"
          aria-label="Word"
          title={DICTIONARY_TERMS.word}
          className={inputClass}
        />
      </td>

      {/* IPA */}
      <td className="py-3 pr-2">
        <input
          type="text"
          value={draft.ipa}
          onChange={(e) => setDraft({ ...draft, ipa: e.target.value })}
          onKeyDown={handleKeyDown}
          disabled={isSaving}
          placeholder="IPA"
          aria-label="IPA transcription"
          title={DICTIONARY_TERMS.ipa}
          className={inputClass}
        />
      </td>

      {/* POS */}
      <td className="py-3 pr-2">
        <input
          type="text"
          value={draft.partOfSpeech}
          onChange={(e) => setDraft({ ...draft, partOfSpeech: e.target.value })}
          onKeyDown={handleKeyDown}
          disabled={isSaving}
          placeholder="POS"
          aria-label="Part of speech"
          title={DICTIONARY_TERMS.partOfSpeech}
          className={inputClass}
        />
      </td>

      {/* Gloss */}
      <td className="py-3 pr-2">
        <input
          type="text"
          value={draft.gloss}
          onChange={(e) => setDraft({ ...draft, gloss: e.target.value })}
          onKeyDown={handleKeyDown}
          disabled={isSaving}
          placeholder="gloss"
          aria-label="Gloss"
          title={DICTIONARY_TERMS.gloss}
          className={inputClass}
        />
      </td>

      {/* Etymology — textarea (D-11, UI-SPEC: min-height 96px) */}
      <td className="py-3 pr-2">
        <textarea
          value={draft.etymology}
          onChange={(e) => setDraft({ ...draft, etymology: e.target.value })}
          onKeyDown={handleTextareaKeyDown}
          disabled={isSaving}
          placeholder="Etymology (markdown)"
          aria-label="Etymology"
          title={DICTIONARY_TERMS.etymology}
          className={`${inputClass} resize-y`}
          style={{ minHeight: '96px' }} // UI-SPEC constraint — not a spacing token
        />
      </td>

      {/* Tags — TagInput */}
      <td className="py-3 pr-2">
        <TagInput
          value={draft.tags}
          onChange={(tags) => setDraft({ ...draft, tags })}
        />
      </td>

      {/* Actions */}
      <td className="py-3" colSpan={2}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving || !draft.word.trim() || !draft.gloss.trim()}
            className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? 'Saving…' : 'Save word'}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={isSaving}
            className="px-3 py-1.5 text-sm rounded-md border border-line-strong hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Discard changes
          </button>
        </div>
      </td>
    </tr>
  );
}
