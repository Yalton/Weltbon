import type { SyncErrorCode } from './syncErrorCopy';

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
  'invalid-remote-url': "That doesn't look like a Weltbon address. It should start with https:// and have nothing after the host.",
  'peer_credentials_rejected': "Email or password wasn't accepted by that instance. Check both and try again.",
  'peer_unreachable': "Couldn't reach a Weltbon instance at that address. Check the address and that it's online.",
  'peer_not_weltbon': "Something answered at that address, but it isn't a Weltbon instance.",
};

const RUN_ERROR_COPY: Record<SyncErrorCode, string> = {
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

function isRunErrorCode(code: string): code is SyncErrorCode {
  return Object.hasOwn(RUN_ERROR_COPY, code);
}

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
