/**
 * on the LLM keys page (LlmKeys.tsx) alongside the Anthropic/OpenAI key
 * table. Lets a desktop user point Weltbon at their own Ollama server and
 * browse what it has installed.
 *
 * ── Why this renders nothing off local mode ──────────────────────────────
 * A hosted Weltbon instance has no way to reach a user's local machine, and
 * accepting a user-supplied endpoint there would be an SSRF vector (see
 * api/src/routes/llm-connections.ts file header). The `localMode !== true`
 * guard below is PRESENTATION ONLY — the server enforces the restriction
 * independently and twice (conditional route registration + a live
 * `env().localMode` re-check in every handler). Do not treat this guard as
 * the security boundary; it exists so a hosted user is not shown a control
 * that would only ever 403.
 *
 * ── Why installed models are listed, not filtered ────────────────────────
 * `useOllamaModels` returns EVERY installed model, including tool-incapable
 * ones (e.g. `llava`, a vision model with no tool-calling support). A model
 * that cannot tool-call cannot return audit findings, so it is listed with
 * the reason inline rather than omitted — a user who just pulled it should
 * see why it is unavailable here, not wonder whether the pull failed.
 * (Contrast: `useListModels('ollama')` in useAudits.ts, which backs the
 * per-universe audit picker, gets the PRE-filtered tools-only list from the
 * server — that dropdown has no use for a model it can never run.)
 *
 * ── Why baseUrl is a plain input, not treated as a secret ────────────────
 * The connection's `baseUrl` is a LAN/loopback address, not a credential —
 * the backend returns it in clear (llm-connections.ts). Only the optional
 * `secret` field (a bearer for a proxy in front of Ollama, if any) is
 * secret, and the server never echoes it back — only its 4-char suffix.
 */
import { useEffect, useState } from 'react';
import { useInstanceConfig } from '../hooks/useInstanceConfig';
import {
  useLlmConnection,
  useSaveLlmConnection,
  useTestLlmConnection,
  useOllamaModels,
} from '../hooks/useLlmConnection';
import { formatRelative } from '../utils/formatRelative';
import { ApiError } from '../api/client';

export function OllamaConnectionSection() {
  const { localMode } = useInstanceConfig();
  const isLocal = localMode === true;
  const { data: connection } = useLlmConnection('ollama', { enabled: isLocal });
  const { data: models, isLoading: modelsLoading } = useOllamaModels('ollama', { enabled: isLocal });
  const save = useSaveLlmConnection('ollama');
  const test = useTestLlmConnection('ollama');

  const [baseUrl, setBaseUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    if (connection?.baseUrl !== undefined) setBaseUrl(connection.baseUrl);
  }, [connection?.baseUrl]);

  if (!isLocal) return null;

  const handleSaveAndTest = async () => {
    setStatusError(null);
    try {
      // llm-connections.ts's "PUT does not validate" comment). Chaining the
      await save.mutateAsync({ baseUrl, secret: secret === '' ? undefined : secret });
      await test.mutateAsync();
      setSecret(''); // never re-display what was just submitted
    } catch (err) {
      setStatusError(
        err instanceof ApiError ? err.message : 'Could not reach the server. Try again in a moment.',
      );
    }
  };

  const isSaving = save.isPending || test.isPending;

  return (
    <section
      aria-labelledby="ollama-section-heading"
      className="mt-8 rounded-md border border-line p-5"
    >
      <h2 id="ollama-section-heading" className="text-lg font-semibold tracking-tight">
        Local Ollama
      </h2>
      <p className="mt-2 text-sm text-ink-secondary leading-[1.5]">
        Point the gap auditor at an Ollama server on this machine. Audits run
        entirely on your own hardware — no worldbuilding content leaves your
        network.
      </p>

      <div className="mt-4">
        <label htmlFor="ollama-url" className="block text-sm mb-1">
          Server address
        </label>
        <input
          id="ollama-url"
          value={baseUrl}
          placeholder="http://localhost:11434"
          onChange={(e) => setBaseUrl(e.target.value)}
          className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
        />
      </div>

      <div className="mt-3">
        <label htmlFor="ollama-secret" className="block text-sm mb-1">
          Bearer token <span className="text-ink-muted">(optional — only if a proxy sits in front of Ollama)</span>
        </label>
        <input
          id="ollama-secret"
          type="password"
          value={secret}
          placeholder={connection?.bodySuffix ? `••••••••${connection.bodySuffix}` : ''}
          onChange={(e) => setSecret(e.target.value)}
          className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
        />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSaveAndTest}
          disabled={isSaving || baseUrl === ''}
          className="bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 rounded-md disabled:opacity-50"
        >
          {isSaving ? 'Saving…' : 'Save and test'}
        </button>
        {connection?.lastValidatedAt && !statusError && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            Reachable as of {formatRelative(connection.lastValidatedAt)}
          </span>
        )}
        {statusError && (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {statusError}
          </span>
        )}
      </div>

      <div className="mt-5">

        <p id="ollama-models-heading" className="text-sm mb-1">
          Installed models
        </p>
        {modelsLoading && (
          <p className="text-sm text-ink-muted italic">Checking your Ollama server…</p>
        )}
        {!modelsLoading && (models === undefined || models.length === 0) && (
          <p role="status" className="text-sm text-ink-secondary italic">
            No models found. Save a reachable server address, then pull a model with tool support
            (e.g. <code>ollama pull qwen3</code>).
          </p>
        )}
        {!modelsLoading && models !== undefined && models.length > 0 && (
          <ul
            aria-labelledby="ollama-models-heading"
            className="rounded-md border border-line divide-y divide-[color:var(--color-line)] text-sm"
          >
            {models.map((m) => (
              // Listed rather than hidden: a user who pulled a vision-only
              <li key={m.name} className="px-3 py-2 flex items-baseline justify-between gap-3">
                <span className={m.supportsTools ? '' : ' text-ink-secondary'}>
                  {m.name}
                </span>
                {!m.supportsTools && (
                  <span className="text-xs text-ink-secondary shrink-0">
                    no tool support, cannot run audits
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-ink-muted">
          The actual model used for an audit is chosen per universe, in that universe&rsquo;s Settings
          → AI Gap Auditor tab.
        </p>
      </div>
    </section>
  );
}
