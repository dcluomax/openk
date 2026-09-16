# Devices, settings and playback history

OpenK settings follow **both the person and the machine**. When the deployment
runs behind the private account service, each signed-in account keeps portable
defaults on the server, and every browser it signs in on keeps its own
hardware-sensitive overrides. The value a surface applies is:

```
built-in safe default  →  your account default  →  this device's override
```

Two pages are added for this: `/devices` (names, roles, topology and overrides)
and `/history` (what your own devices actually played). Both are linked from the
account menu in the library, the phone remote and the television.

The interface uses Simplified Chinese throughout, including account-menu links
(`设备设置`, `播放历史`), controls, device-role labels and status/error messages.
User-provided names and browser-provided hardware names are kept as supplied;
API field names and saved preference values do not change with the interface language.

Without the account service, nothing changes: preferences stay in this browser's
`localStorage` exactly as before, `/api/user/*` returns `404`, and the two pages
are not served.

## What is stored where

| Setting | Level | Notes |
| --- | --- | --- |
| `sing_mode` | account | your preferred accompaniment/guide-vocal style |
| `reverb` | account | preset name (`none`, `room`, `ktv`, `hall`, `church`) |
| `view` | account | library list or cover view |
| `accompaniment_volume`, `guide_volume` | account | mixer levels, 0–100 |
| `mic_volume` | account default + device override | 0–200 |
| `mic_monitor`, `howl_guard` | account default + device override | booleans |
| `output_volume` | device only | 0–100, applied to the speaker bus |
| `audio_input`, `audio_output` | device only | browser-issued media device ids |

Values are re-validated on the server and again in the browser, so a damaged row
can never push an out-of-range gain into the audio graph.

`audio_input` and `audio_output` are ids that **this browser issues for this
site**. The same headphones have a different id in another browser or on another
machine, so these two values are never copied into account defaults and never
travel to another device. If a saved id is missing, OpenK says so and falls back
to the system default instead of pretending the choice worked. Browsers that
cannot choose an output device (no `setSinkId`) show that plainly too.

Inside a room, the original/accompaniment switch belongs to the **room**: it is
shared playback state for everyone in it. Pressing it updates the room and also
records your personal preference, but your personal preference never flips a
room by itself.

## Devices

A device is one browser installation. The first time you sign in, the browser
creates a random 32-character id in `localStorage` and sends it with your
requests.

* It is **not** a credential. Every row is keyed by the authenticated account
  first, so knowing an id grants nothing.
* It is **not** a hardware fingerprint. It is a random value, it is per browser
  profile, and clearing site data simply creates a new one.
* A shared browser is safe: signing in as someone else selects that person's own
  row for the same id, so settings are never inherited or leaked. Preferences
  saved in this browser's standalone `openk.prefs` are **not** adopted
  automatically either — `/devices` offers an explicit `导入这个浏览器保存的设置`
  button instead.

On `/devices` you can rename a device, give it roles (player, controller, local
microphone), change your account defaults, override them for this browser, clear
those overrides, pick a preferred player, and remove a device you no longer use.
Removing a device deletes its overrides; history keeps the name the device had
when it played.

An account keeps at most 24 devices. When that limit is reached, a further
browser cannot register, and the page says so instead of failing: it reads your
device list without claiming a slot, leaves this browser's own controls
disabled, and registers itself only after you deliberately remove a device.
Nothing is ever evicted automatically.

### Connected room devices and roles

The main player shows a room-device list. On the phone, expand the member/device
summary; on TV, open the room panel. These lists describe **currently connected
devices**, not every saved device in the account. The account member list remains
separate: one person signed in on a computer and phone is still one member, but
both devices are visible.

Each row uses the device's saved name when registered and shows Chinese role
labels: `播放器`, `遥控器`, `麦克风`. Roles combine the functions of its open pages
with explicitly assigned device roles. A browser can have several roles;
multiple tabs for one account/browser are grouped into one row. Closing one tab
removes only that connection's functions. The actual receiving lease is marked
on its device, not on every device owned by the same account.

These labels are descriptive, not credentials or permission grants. A microphone
label does not mean capture is active and does not stream sound to another
device. Settings remain account/device-scoped; this does not migrate the account's
current room or preferred-player setting to a different ownership model.

Connections announce a random per-page identifier through the authenticated room
API. The private room snapshot returns opaque room-scoped device identifiers,
names and roles, never browser/account identifiers, settings or room credentials.
Disconnected connections expire after a short timeout if their unload notification
cannot reach the server. Presence is bounded, is not saved to `rooms.json`, and
is not restored after a process restart.

### Topology and where playback starts

The connection map is drawn from your own data with plain HTML/CSS/SVG — no
external assets — and the choices under it are real:

* **Preferred player** decides where a song is asked to start. If you pick a
  song on a device that is *not* the preferred player, that device will not take
  the room's player lease by itself; it shows which device playback is set to and
  offers explicit activation instead.
* Activating anyway is always allowed, because it is an explicit gesture, and the
  page says it is playing here instead of the preferred device.
* The room still allows exactly **one** player at a time. Topology guides that
  single lease; it never creates a second one.

The main player's `启用播放器` button is available even with an empty room queue.
It prepares audio output with an explicit gesture without opening a microphone.
The first queued song then starts automatically on that ready receiver, including
when it was selected on a phone. Later songs follow on completion; adding songs
does not resume a current song that was deliberately paused.

Browser security still rules: **no page can grant microphone permission or start
audio on another device.** A preferred television only starts playing after
someone opens OpenK there and activates it. A saved `mic_monitor: true` does not
open a microphone either — the browser permission prompt and a real gesture are
still required.

### Microphones are local

OpenK does **not** stream a phone microphone to a television. The "local
microphone" role only describes a device that can capture what it hears itself,
next to the person singing. Supported topologies are:

* one device that plays and captures its own microphone, with other devices as
  controllers; or
* a television that plays while phones pick songs — the television's own
  microphone input is the one that is mixed.

Selecting a microphone on `/devices` changes which input *that* device uses. It
does not route sound between devices.

## Playback history

`/history` lists songs that your own devices really played.

* A record is written only when a device holding a **validated player lease**
  reports *continuous playback*: the room is playing, that receiver reports
  `playing`, and both the song position and the clock moved forward by at least
  three seconds inside one uninterrupted window. A queue insertion, a "play"
  command, a blocked autoplay or a suspended audio graph produces nothing.
* Seeking, restarting, pausing or buffering ends the window and starts a new
  one, so jumping the position — by itself, or then waiting there — is never
  mistaken for playing. The media also cannot outrun the clock: a position that
  advances further than the elapsed time simply opens a new window.
* One queue entry is one record. Reloads, retries and repeated heartbeats update
  the same record instead of duplicating it, and restarting the current song
  keeps updating it. Picking the same song again creates a new queue entry, and
  therefore a new record.
* `ended` marks an existing record finished; it never creates one on its own.
* Progress is what the player reported. It is not a measurement of the sound in
  the room, and OpenK does not claim it is.
* History belongs to the account whose device played: in a shared room, the
  person operating the receiver gets the record, and other members do not appear
  in it. Guests (`/api/trial/`) create no account history at all.
* Entries carry a title, artist, time, device name and progress. They never carry
  file paths, source URLs, recordings or other members' details, and a song that
  is later removed from the catalogue keeps its snapshot.
* Reads are paginated and bounded, and the newest 500 entries per account are
  kept. Account B can never read or delete account A's entries by guessing a
  device, room or entry id.
* "Clear my history" and per-entry deletion always ask first. Nothing is ever
  cleared automatically.

## Storage and operations

Everything lives in one SQLite file next to the other OpenK data:

```
$OPENK_DATA_DIR/user-state.sqlite3      # accounts, devices, history (mode 0600)
```

Django keeps only identities and profiles; this file holds the application's own
settings keyed by the authenticated account UUID. Writes use immediate
transactions, so two of your devices cannot interleave a read-modify-write, and
every settings change carries a revision. If another device saved first, the
save is refused with `revision_conflict`, the page reloads the newer values and
reapplies your change on top, so the other device's untouched settings survive.

If the store cannot be written, the page shows the failure. It never reports a
save that did not happen, and it never falls back to another account's cached
values — playback and singing continue regardless.

## HTTP surface

All of these require an authenticated account and return `404` when the account
integration is disabled. The optional `X-OpenK-Device` header names the current
browser installation; `X-OpenK-Expected-Account` fences a concurrent
account change exactly as the room API does.

Room presence uses `POST /api/rooms/{room_id}/presence?after=<revision>` with
`client_id`, optional `device_id`, `label` and functional `roles`. The same room
authentication and concurrent-account fence apply. Replies contain ordinary
room state plus `devices` and the caller's `presence_id`; device metadata updates
even when the queue revision is unchanged. `DELETE` on
`/api/rooms/{room_id}/presence/{client_id}` removes only the caller's connection.
Player claims optionally include `client_id` and `device_id` for attribution;
the existing no-body claim API and player-token enforcement remain supported.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/user/state` | read defaults, devices, topology and effective settings |
| `POST` | `/api/user/state` | register or refresh this browser, then read the same state |
| `PUT` | `/api/user/defaults` | save account defaults (`revision`, `settings`) |
| `PUT` | `/api/user/topology` | set or clear the preferred player |
| `PATCH` | `/api/user/devices/{id}` | rename, set roles, set or clear overrides |
| `DELETE` | `/api/user/devices/{id}` | remove a device |
| `GET` | `/api/user/history` | paginated history (`limit`, `before`) |
| `DELETE` | `/api/user/history` | clear this account's history |
| `DELETE` | `/api/user/history/{entry}` | delete one entry |
