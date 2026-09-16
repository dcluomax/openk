# One-song guest trials

The optional guest trial lets someone try karaoke without creating an account.
It is a separate, limited player, not a shared login named `guest` and not an
anonymous account-room membership. Regular accounts and their full player,
recordings, library tools and rooms keep their existing behavior.

The feature is **disabled by default**. It requires an account gateway that
implements the anonymous session contract below and the existing private
proxy-to-application identity key. Enabling it without that key fails startup.

## Visitor experience

The guest player and its account entry use Simplified Chinese, matching the
main player. Buttons, accessible labels, playback state and permission/error
messages are localized; song metadata and API status values stay unchanged.

An explicit, CSRF-protected action on `/auth/guest/` grants an anonymous browser
session and opens `/try`. The visitor can search the available song names and
choose **one** song. The choice is final for that session, including across tabs,
page reloads and application restarts.

The trial player offers accompaniment, an optional guide track, synchronized
lyrics, volume and transport controls. Microphone monitoring is optional and
requires an explicit browser permission/activation; it does not upload a
recording or access the private recordings library. It does not use account
rooms, control someone else's player, or stream a phone microphone to a TV.

Playback never starts merely because the page loaded. A returning active trial
can resume the same chosen song after an explicit gesture. Completing the song
ends the trial; the visitor must sign in to continue. The server also expires an
unfinished selection after the song duration plus five minutes of preparation/
pause grace, capped at twenty minutes. Eligible songs have known, positive
durations of at most fifteen minutes.

The grant has a fixed maximum lifetime of twenty-four hours. Repeating the entry
action must not replace or extend an existing grant. This is a **per-browser-
session limit**, not proof that a person has never tried the service before:
clearing cookies or using another browser can acquire a different session.
Rate limiting reduces abuse but is not person-level identity or billing control.
Likewise, delivered audio cannot be revoked from an already modified/caching
client; the service is not DRM. Only offer material you are entitled to share.

## Proxy contract

Set `OPENK_GUEST_TRIAL_ENABLED=true` in both the application and the matching
account service only after the guest gateway routes are installed. Do not
replace the application's normal authentication policy with a broad exception.

The account service owns a native, Secure, HttpOnly, host-only session cookie.
It stores a stable random trial UUID and fixed expiry in an **anonymous** session;
it creates no user, profile or invitation. Guest grants must never satisfy the
ordinary account authorization endpoint.

A separate internal authorization endpoint validates this session and returns
`X-OpenK-Guest`, containing URL-safe base64 of UTF-8 JSON with exactly:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "expires_at": 2000000000
}
```

The example expiry is illustrative, not an accepted permanent grant. The
application requires a current integer expiry no more than twenty-four hours
ahead (plus a small clock-skew allowance), a canonical UUID, and the existing
private `X-OpenK-Identity-Key`. Base64 is not a signature or a browser credential.
Never expose the hop key or accept an assertion supplied by the browser.

The gateway must:

- Publicly route only `/try`, `/try/`, `/trial-assets/trial.js` and
  `/trial-assets/trial.css`, plus the account service's existing public assets
  and explicit guest-entry action.
- Authorize `/api/trial/` through the **guest-only** session endpoint; overwrite
  `X-OpenK-Guest` from its response, clear `X-OpenK-Account`, and inject the private
  hop key over the protected upstream connection.
- Keep the guest verifier internal and fail closed on missing, expired or
  malformed grants and account-service failures.
- Clear client-supplied guest assertions on normal routes. Keep `/api/jobs`,
  `/api/rooms`, `/media`, recordings, imports and administration behind ordinary
  account authentication. A trial assertion also causes the application to
  reject requests outside the trial API.
- Preserve Host, Origin, verified upstream TLS and byte-range behavior. Limit
  guest mutation bodies to a small bound and rate-limit new grants/API traffic
  without disrupting legitimate audio-range requests.

The existing trusted-LAN/worker boundary on the raw origin is unchanged.
Public-site protection still belongs to the gateway; an origin port must not
be exposed directly just because trials have been enabled.

## Limited API

| Request | Purpose |
| --- | --- |
| `GET /api/trial/state` | Return `available`, `active`, `complete` or `expired` |
| `GET /api/trial/catalog?q=...` | At most fifty sanitized song metadata entries |
| `POST /api/trial/select` | Atomically choose the one song using `{job_id}` |
| `GET /api/trial/media/instrumental` | Read only the active trial's accompaniment |
| `GET /api/trial/media/vocals` | Read only its declared optional guide track |
| `GET /api/trial/lyrics` | Read only its declared JSON lyrics |
| `POST /api/trial/complete` | Complete the selection using an empty JSON object |

Writes require a browser Origin and pass the existing same-origin validation.
Unexpected body fields and malformed identifiers are rejected. Selecting the
same song again is idempotent and does not extend its window; selecting a
different song returns HTTP 409. A consumed/expired trial cannot read audio or
lyrics or select another song (HTTP 410).

The catalog exposes only bounded ID/title/track/artist/duration metadata, not
source URLs, filesystem paths, account identities or recordings. Media routes
have no caller-chosen job ID or filesystem path. They resolve the selection
server-side, check containment in that job, and retain the normal media handler's
fixed MIME types, `nosniff`, sandbox CSP and Range support. Trial responses use
`private, no-store`; audio and lyrics byte ranges are not transport-compressed.

## Persistence and operations

Selections live in `OPENK_DATA_DIR/guest-trials.sqlite3`, separate from account
credentials and room state. SQLite write transactions serialize simultaneous
choices, and the stored original session expiry cannot be changed. Completed
records remain until their original grant has expired; cleanup must not make an
unexpired identity eligible again.

Back up this database with other application state before a coordinated
deployment. Keep account cookies/signing state and proxy assertions consistent
across account/application updates. Do not restore an older quota database to
reset visitors' trials. Disabling the feature is a forward configuration change,
not a reason to delete existing accounts or restore an old room snapshot.
