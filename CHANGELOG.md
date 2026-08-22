# Changelog

Notable changes to Weltbon, newest first. This file starts at the changes below
because they are the first observable API contract changes to ship without a
release note; earlier history is in the git log.

Entries record changes a **consumer** can observe — HTTP statuses and response
codes, sync-protocol behaviour between peers, and anything a self-hosted
instance or the desktop app could key on. Internal refactors do not belong here.

## Unreleased

### Changed — `POST /api/sync/remotes` (from #42)

Two response statuses changed. Both are deliberate, but they are observable
contract changes, so they are recorded here rather than left to be discovered at
runtime. See #56.

**Peer credential rejection is now `422`, not `401`**, with
`code: 'peer_credentials_rejected'`.

The old `401` was wrong in a way that had teeth. The web client retries any
non-`/auth/` 401 after attempting a token refresh, and on a failed refresh it
clears the local access token and throws `UnauthenticatedError`. So a typo in
the *peer's* password could trigger a local token rotation, re-send the
credentials to the peer, and — with an expired cookie — sign the user out of
their own desktop app, surfacing as a bare "Not authenticated".

`422` states what actually happened: the request was well-formed and locally
authenticated, and an upstream dependency rejected the credentials it carried.

The route's own missing-JWT `401` is unchanged.

**Re-registering a known base URL is now `200`, not `201`.**

Registration is idempotent per `(owner, normalized base URL)`. Registering a URL
the caller already holds returns `200` with the existing record and replaces the
stored token, instead of inserting a second row. A genuinely new URL still
inserts and returns `201`.

This is also the documented repair path for a revoked token.

### Added

`POST /api/sync/remotes` now returns `code: 'invalid-remote-url'` alongside its
existing `400`. The `error` field is unchanged.
