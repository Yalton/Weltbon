/**
 * #42 — user-facing copy for every failure the one-button connect flow can hit.
 *
 * WHY THIS EXISTS RATHER THAN `error.message`. Every string the four connect
 * calls can throw is written for an OPERATOR reading a Sync settings page, and
 * says so in the vocabulary #42's Definition of Done bans outright. These are
 * the real ones, verbatim from the server:
 *
 *   "Invalid remote URL: not a valid absolute URL"                       (remote-url.ts:24,90)
 *   "Invalid remote URL: credentials in the URL are not allowed — the
 *    PAT travels in a header"                                            (remote-url.ts:96)
 *   "This remote resolves to this Weltbon instance and cannot be linked
 *    or synced"                                                          (run-errors.ts:129)
 *   "The remote rejected the stored PAT"                                 (run-errors.ts:85)
 *   "The universe no longer exists on the remote — re-link or remove
 *    this link"                                                          (run-errors.ts:178)
 *
 * Rendering any of those verbatim teaches the user what a remote, a link and a
 * PAT are — the exact thing this feature exists to stop. So nothing here is
 * derived from `message`: every rendered sentence is a constant chosen by the
 * machine-readable `code`, and an unrecognized code falls back to a
 * step-attributed sentence rather than to the raw text.
 *
 * WHY NOT `syncErrorCopy.ts`'s `syncErrorMessage()`. That module solves the
 * OTHER half of the same problem — it keeps raw exception text (which can embed
 * row ids from another universe, the C-21/D-09 leak) off screen — and this
 * module observes the same rule. But its prose cannot be reused here: it is
 * deliberately written in the operator's nouns, as its own docstring states
 * ("Vocabulary: 'remote' names the saved connection row a user manages at
 * /settings/sync"), so its copy for `SELF_REMOTE` alone contains "remote",
 * "linked" and "access token". What IS shared is its `SyncErrorCode` union:
 * `RUN_ERROR_COPY` below is a `Record` over it, so a code added to
 * `run-errors.ts` and mirrored there becomes a compile error here instead of a
 * silent fall-through to the generic sentence.
 */
import type { SyncErrorCode } from './syncErrorCopy';

/**
 * The step the flow was on when it failed, in the words the pane says it in.
 * Exported because the failure pane names the step on screen (DoD: "Every
 * failure names its step") and the fallback sentence names it too, and the two
 * must not drift into saying different things about one failure.
 */
export type ConnectFailureStep = 'authenticating' | 'discovering' | 'adopting' | 'syncing';

export const STEP_GERUND: Record<ConnectFailureStep, string> = {
  authenticating: 'signing you in',
  discovering: 'looking for your universes',
  adopting: 'setting up your universe',
  syncing: 'bringing in your content',
};

/**
 * Codes from `POST /sync/remotes` — the credential exchange (step 1) and the
 * base-URL check in front of it.
 *
 *   `invalid-remote-url`         remote-url.ts:22 (InvalidRemoteUrlError.code)
 *   `peer_credentials_rejected`  peer-auth.ts:26 (PeerAuthCode)
 *   `peer_unreachable`           peer-auth.ts:27
 *   `peer_not_weltbon`           peer-auth.ts:28
 */
type ConnectAuthCode =
  | 'invalid-remote-url'
  | 'peer_credentials_rejected'
  | 'peer_unreachable'
  | 'peer_not_weltbon';

const AUTH_ERROR_COPY: Record<ConnectAuthCode, string> = {
  // The common typo is an address with no scheme, which the server rejects as
  // "not a valid absolute URL". The design spec's error table names this
  // sentence directly.
  'invalid-remote-url': "That doesn't look like a Weltbon address. It should start with https:// and have nothing after the host.",
  'peer_credentials_rejected': "Email or password wasn't accepted by that instance. Check both and try again.",
  'peer_unreachable': "Couldn't reach a Weltbon instance at that address. Check the address and that it's online.",
  'peer_not_weltbon': "Something answered at that address, but it isn't a Weltbon instance.",
};

/**
 * Codes from steps 2-4 — every `SyncRunError` subclass, because the discovery,
 * adopt and first-pull calls all surface that hierarchy. Exhaustive over
 * `SyncErrorCode` by construction.
 */
const RUN_ERROR_COPY: Record<SyncErrorCode, string> = {
  // The design spec's error table names this sentence directly.
  SELF_REMOTE: "That's this instance — connect to a different one.",
  'link-not-found': 'This app is no longer set up to reach that instance. Connect to it again.',
  'local-materialization-incomplete': "Your content didn't finish arriving on this device, so nothing was recorded as complete. Try again.",
  forbidden: "You don't have access to that universe.",
  busy: 'This universe is already being brought in. Wait for that to finish, then try again.',
  'remote-key-undecryptable': "This app couldn't use the sign-in it saved for that instance. Connect again with your email and password.",
  'remote-unreachable': "Couldn't reach that Weltbon instance. Check that it's online, then try again.",
  'remote-unauthorized': "That instance no longer accepts this app's saved sign-in. Connect again with your email and password.",
  'remote-universe-forbidden': 'That universe belongs to a different account on that instance.',
  'remote-payment-required': 'That instance needs an active subscription before it will send your content.',
  'remote-quota-exceeded': 'That instance is out of storage space.',
  'remote-incompatible': 'The two copies of Weltbon are different versions. Update the older one, then try again.',
  'remote-universe-missing': 'That universe no longer exists on that instance.',
  'blob-unavailable': "Some images couldn't be transferred. One of the two instances no longer has their contents.",
  'remote-rejected': "That instance wouldn't accept the exchange.",
  'universe-not-on-remote': "That universe isn't on that instance any more. It may have been deleted there, or it may belong to a different account.",
  'universe-already-local': 'You already have that universe on this device.',
};

function isConnectAuthCode(code: string): code is ConnectAuthCode {
  return Object.hasOwn(AUTH_ERROR_COPY, code);
}

// `Object.hasOwn`, not `in` — the same trap syncErrorCopy.ts's `knownCode`
// documents: `'constructor' in RUN_ERROR_COPY` is true, and the lookup would
// then render `String(Object)` at the user.
function isRunErrorCode(code: string): code is SyncErrorCode {
  return Object.hasOwn(RUN_ERROR_COPY, code);
}

/**
 * The one sentence the connect flow may show for a failure.
 *
 * `err` is whatever the hook put in `state.error` — `{ message, code? }`, where
 * `code` came off `ApiError.body.code`. `message` is accepted but NEVER
 * rendered; it is here only so a caller cannot accidentally be handed a value
 * this function refuses to look at.
 *
 * The fallback names the step instead of falling back to `message`, so an
 * un-mapped code degrades into "something went wrong while X" rather than into
 * operator vocabulary. The 503 encryption-unconfigured body lands here on
 * purpose: its message is the operator-facing one the design spec keeps
 * unchanged on the wire, and it contains "remote", so this pane must not print
 * it.
 */
export function connectErrorMessage(
  err: { message?: string; code?: string } | null | undefined,
  step: ConnectFailureStep,
): string {
  const code = err?.code;
  if (code) {
    if (isConnectAuthCode(code)) return AUTH_ERROR_COPY[code];
    if (isRunErrorCode(code)) return RUN_ERROR_COPY[code];
  }
  return `Something went wrong while ${STEP_GERUND[step]}. Try again in a moment.`;
}
