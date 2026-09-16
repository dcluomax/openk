# Accounts and the current room

OpenK can consume an authenticated account context from a trusted reverse proxy.
The application does not store login passwords or implement an identity provider.
An account service must protect the whole public site, including its library,
media, imports and administration routes; room membership is not library tenancy.

The optional [one-song guest trial](guest-trials.md) has a separate anonymous
session and restricted API. It does not use a shared account, create a profile,
or make guest sessions valid for the normal account/room endpoints.

## Room-first behavior

When account integration is enabled, `/`, `/index.html` and `/library` keep the
full song catalog, player, lyrics editor, mixer and recorder. Entering OpenK
resumes the account's current room or creates a private solo room. A room is a
membership and shared queue, not a requirement to open a separate TV page.

Picking a song can start this device after the user's audio gesture and a
successful room-player lease claim. If another device is already playing the
room, picking and transport controls use that shared session instead of starting
competing audio. A returning page can explicitly enable local playback using
`在本机播放`; loading a URL alone never grants audio permission. Queued copies of
the same song remain separate room entries, not a deduplicated local list.

`/tv` provides the dedicated big-screen layout and `/remote` remains the
controller-only phone layout. With no active receiver, the account remote's
play button opens the full local player instead of silently toggling a room
flag. Neither account-mode interface restores an independent browser-only queue.

A user has one current membership, not a separate identity for every device.
Phone and TV sessions for the same account see the same room and singing identity.
Different singers use different accounts. The lobby at `/rooms` is a room
selector, not a state in which the user has left every room.

Joining validates the destination and pairing code before leaving the old room.
Leaving a party returns the user to a private solo room. A departing host hands
ownership to a remaining member; an empty room is removed. Disbanding creates
separate solo rooms for the former members. No operation deletes catalog songs.
Leaving an already private solo room is idempotent and keeps its queue.

The server reserves one room slot per active account even while users share a
party, so leaving or disbanding cannot fail merely because those users now need
separate solo rooms. The existing 64-slot bound also counts standalone rooms.
Inactive rooms retain the existing 12-hour idle and 48-hour total-age limits;
returning after expiry creates a new solo room.

Display names come from persistent account profiles. Editing a browser label or
replaying another account's old room capability cannot change the caller's
identity. Role changes and nicknames are reflected in room state. A host can
rotate the six-digit pairing code without changing members' account identities.
Only the pairing-code digest is persisted, so a returning owner on a new browser
may need to generate a fresh invitation code.

Players stop stale playback when the account moves to a different room or its login
expires. A fresh room never starts audible playback without a new user gesture.
There remains only one active player lease per room. Singing lists do not
implement phone microphone transmission or acoustic synchronization.

The full player starts the preferred local microphone monitor only after it owns
playback; a passive controller never requests microphone access. If the operating
system suspends its audio output, it stops playback and capture, retains captured
recordings and offers explicit reactivation rather than claiming silent playback.
Normal page exits send an authenticated keepalive lease release. A forcibly killed
browser or failed network may still require the server's short lease timeout.

Dragging the progress bar previews locally and commits one seek when released.
Changing songs or rooms cancels an unfinished drag. Recovery never replays an old
room action into the replacement room, even when the account itself is unchanged.

Signing out ends that browser session and stops its local player; it does not
delete the account's current room or revoke other signed-in device sessions.
Presence expires normally when no device remains. Use the explicit leave action
to move from a party to a private room.

## Account-service experience

The integrated account service is expected to provide persistent display names,
native password-based sign-in/sign-out, password changes and account management.
Ordinary profile editing must not change account identity or grant staff rights.
For a private shared library, use administrator-created accounts or single-use,
expiring account invitations rather than unrestricted public registration.

An **account invitation** admits a user to the site. A six-digit **room pairing
code** only lets an already authenticated user join a room. They are different
credentials; a room code must never bypass site authentication.

Profile/password actions live under `/auth/`, with login at `/auth/login/` and
CSRF-protected logout at `/auth/logout/`. `GET /auth/api/me/` should return the
current identity plus a native CSRF token and those action URLs, or JSON HTTP
401 when signed out. These routes belong to the account service, not this
FastAPI application. Password recovery can remain administrator-assisted when
no email recovery system is configured.

## Trusted proxy contract

Leave `OPENK_IDENTITY_KEY_FILE` unset to preserve standalone pairing behavior.
To enable account integration:

1. Generate a separate random key with at least 256 bits of entropy, encoded as
   43-128 URL-safe characters. Store it privately and mount it read-only into
   the application, for example at `/run/secrets/openk_identity`.
2. Set `OPENK_IDENTITY_KEY_FILE` to that mounted path. A missing or malformed
   configured key fails startup; it must not silently disable authentication.
3. Authenticate every public request through the account service. After successful
   authentication, overwrite `X-OpenK-Account` from that service's response and
   `X-OpenK-Identity-Key` from the private proxy configuration. Never forward
   browser-supplied identity headers unchanged or expose the key in a response.
4. Protect every proxy hop and the raw application port. Keep the existing
   whole-site authentication, HTTPS, Host and Origin defenses in place.

`X-OpenK-Account` is URL-safe base64 of a UTF-8 JSON object with exactly these
fields:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "username": "example-user",
  "display_name": "Example singer",
  "is_staff": false
}
```

The ID is a stable canonical UUID that must not be reused for a deleted account.
Username is a nonempty label of at most 150 characters; display name is at most
40. Labels must be trimmed and contain no control characters. `is_staff` is a
boolean, not a room-host grant. Base64 is an encoding, **not a signature**:
the private hop key authenticates the trusted proxy's assertion. Do not reuse a
worker credential or the account service's cookie-signing secret.

Account mode does not use room bearer tokens. The verified account authorizes
its membership; the separate, short-lived player token still identifies the
device holding a room's playback lease. Standalone capabilities remain available
only for standalone rooms and are not adopted as account identities.

## Application API

| Request | Purpose |
| --- | --- |
| `GET /api/account` | Explicit `{enabled:false}` or the verified current identity and account URLs |
| `POST /api/rooms/current` | Resume/create the caller's current room |
| `POST /api/rooms` | Create a room and move the caller into it |
| `POST /api/rooms/{id}/join` | Validate the code, then move the caller |
| `POST /api/rooms/{id}/leave` | Return to a private solo room |
| `DELETE /api/rooms/{id}` | Host-only disband; prepare solo rooms for former members |
| `POST /api/rooms/{id}/invitation` | Host-only pairing-code rotation |

Account room results include `room_id`, `role`, `account_id`, `account_mode` and
`state`, plus `pairing_code` only when generated or explicitly validated.
Leave/disband results include the caller's replacement under `current`.
An old room after account movement can return HTTP 409 with
`detail: {code: "room_changed", message: "..."}`; clients must stop using the old
state and load the authoritative current room. An expired login returns 401,
not a guest fallback.

Room clients also send `X-OpenK-Expected-Account`, the account ID captured when
that room connection was opened. This optional concurrency guard is not an
authentication credential. If the browser cookie changes to another account,
the server rejects the stale request with HTTP 409 and `code: "account_changed"`
before modifying a room, even when both accounts belong to the same party.
Clients refresh `/api/account` without this guard, then adopt that account's
current room; they must not replay the previous user's action as the new user.

Account and room state remain separate persistent stores. Back up both before a
coordinated deployment, preserve users/session keys, and deploy matching proxy,
account and application contracts. Existing standalone snapshots are not
automatically converted into account-owned rooms by trusting browser history.
Do not blindly run a standalone-only older backend against a snapshot that now
contains account memberships. After users have entered account rooms, preserve
that state and use an account-aware rollback or a forward fix rather than
restoring a stale room/database backup.
