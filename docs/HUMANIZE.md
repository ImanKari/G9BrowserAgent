# Human input — `extension/humanize/`

G9 drives pages with trusted CDP input (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`). v1
sent the minimum: one `mouseMoved` onto the element's exact centre, a press and a release in the same
millisecond, 12 ms between typed characters, one 1400 px wheel event. Every one of those is a machine
signature. This library plans the same actions the way a hand does them, and plans them
**reproducibly**: the same seed, profile and intent always give the same plan, to the millisecond and
the pixel, so a failing run can be replayed with identical motion.

It implements ARCHITECTURE_V2 §6 and decision D8 (AIGuide §2.0); the defaults below and the calibration are its
specification. Environment (fingerprint, `Runtime`, headless tells) is a different problem and is
covered in `docs/STEALTH.md`; this file is only about behaviour.

- [Where it lives and who calls it](#where-it-lives-and-who-calls-it)
- [The plan](#the-plan)
- [The model](#the-model)
- [Every parameter](#every-parameter)
- [The profiles](#the-profiles)
- [Calibration](#calibration)
- [Adding a team profile](#adding-a-team-profile)
- [Delivered timing (measured)](#delivered-timing-measured)
- [Honest limits](#honest-limits)
- [Tests](#tests)

---

## Where it lives and who calls it

```
extension/humanize/
  index.js      the public surface (re-exports everything below)
  prng.js       createRng — mulberry32, seeded from a number or a string
  profiles.js   PROFILES { off, human, stealth } — every number, as plain objects
  profile.js    resolveProfile, validateProfile, PROFILE_SCHEMA, LEVELS
  plan.js       the Plan model, effectiveText, validatePlan, sequence, planGap, the pixel grid
  mouse.js      pickTargetPoint, planMove, planClick, planHover, planDrag, fittsDuration
  wheel.js      planScroll
  keys.js       keyDefinition (US QWERTY), planType, planKeyPress, modifiers, QWERTY adjacency
  calibrate.js  fitProfile — a profile fitted from recordings of a real person
```

The library is **pure** (rule R2): no I/O, no timers, no clock, no hidden randomness, no browser or
Node APIs, no `await`. That is what lets one copy serve both engines — the extension's service worker
and the daemon import the very same files — and it is enforced by a source check in the unit tests.

It only **plans**. Performing a plan is `extension/lib/humanize.js` (`perform(tabId, plan)`), which
honours each step's `at`, lasts until the plan's `durationMs` (a trailing pause — `planGap`'s think
time, a dwell, a key's hold — is waited, with Stop checked; F3), passes a key step's `location` to
`Input.dispatchKeyEvent` (F2), keeps the per-tab pointer position, and records the pointer track for the
evidence (the cursor is drawn from that track, never put in the page — decision D9).

The schedule is absolute (`t0 + at`), with two rules for a dispatcher that falls BEHIND (live round 2:
Chrome for Testing took 35–54 ms per `mouseMoved` against the plans' 8–16 ms, and presses and releases
then went out back to back — 2–8 ms holds): an interval that ends in a decisive step (press, release,
key, wheel notch) keeps at least 80 % of its planned length — the step starts no earlier than the
previous event's start plus that much of the gap; otherwise the absolute schedule applies, so a small
per-event overhead is absorbed instead of accumulating (requiring 100 % slowed Engine 2 typing from a
median 141–156 ms between keys to 173–199 ms) — and an overdue pointer move
whose successor is also an overdue move (same buttons, more than 24 ms behind) is merged into it, so the
pointer catches up with a coarser path instead of arriving seconds late. The result reports `merged` and
`lateMs` (the most a decisive step started behind plan) when either happened. A held button presses with `force: 0.5` (Blink's pressure for a real
mouse; CDP's default 0 read as `pointerdown.pressure` 0 in 50/50 runs), no button with none.

Two time limits in the dispatcher:
- **A pointer event still unanswered after `SLOW_INPUT_MS` (2 s)** triggers a visibility check. A
  hidden page ends the action with `delivery:"not-delivered"`, or `"partial"` when some events had
  already been accepted. A visible page is simply waited for longer, because slow is not lost.
- **A wheel notch unanswered after `WHEEL_TIMEOUT_MS` (4 s)** is reported as a stall, with the cause
  that is actually present: a hidden page, or a running screencast. It is never replaced by a
  programmatic scroll.

Stop (the panel or the desktop app) is checked before every press, release and key. During moves
and long waits it is checked every 50–100 ms: at most once per 50 ms, and waits are slept in 100 ms
slices. The error then says how many of the plan's events were sent.

`tools/interact.js` chooses the planner per action and level; `tools/record.js` collects the raw input
samples that `fitProfile` reads.

**Which level an action runs at** is decided by `levelFor` in the same file: the call's `humanize`
(else the engine's default for the tab), raised to the tab's stealth level when that is stricter —
decision D-b, order off < human < stealth. A tab in a stealth context always gets stealth input rules
(no `DOM.focus`, no programmatic scroll, no `Input.insertText` without `fast:true`); a raised built-in
level becomes that level's built-in profile, a calibrated profile keeps its fitted numbers and takes the
level, and the action's result says so (`humanize.raisedFrom`, `humanize.stealthLevel`). On a
launched engine, the tab's stealth level is its context's `stealth` setting. In the person's own
browser (Engine 1) it is `stealth` only while the side panel's Input is Stealth. At Human or Direct
the panel only sets the default, so an agent's `humanize:"off"` still gets direct input there
(`extension/lib/platform-extension.js`).

```js
import { createRng, resolveProfile, planClick, planType } from '../humanize/index.js';

const rng = createRng('run-2026-09-21:login:3');      // the seed is recorded with the run
const profile = resolveProfile('human');              // or 'stealth', 'off', a team profile object
const click = planClick(rng, profile, {
  from: { x: 812, y: 440 },                          // where the pointer is now
  box: { x: 600, y: 300, width: 140, height: 36 },   // the element, in viewport CSS px
  viewport: { width: 1280, height: 720, dpr: 1.25 },
});
const typing = planType(rng, profile, { text: 'Admin@2026', field: { password: false, numericMask: false } });
```

---

## The plan

```
Plan = { steps: Step[], durationMs, end: {x,y} | null, meta: { kind, seed?, profile, … } }

Step = { at, kind:'mouse', type:'mouseMoved'|'mousePressed'|'mouseReleased'|'mouseWheel',
         x, y, button, buttons, clickCount, modifiers, deltaX?, deltaY? }
     | { at, kind:'key', type:'rawKeyDown'|'keyDown'|'keyUp'|'char', key, code?,
         windowsVirtualKeyCode?, nativeVirtualKeyCode?, location?, text?, unmodifiedText?,
         modifiers, autoRepeat:false }
     | { at, kind:'pause', ms, reason }
```

- **Time.** `at` is integer milliseconds from the start of the plan. Steps are sorted by `at`; ties
  keep their build order, which matters (a `rawKeyDown` and its `char` share a millisecond). A
  dispatcher honours `at` and nothing else.
- **Pause steps are markers.** Their time is already in the `at` of the next step; they exist so logs
  and evidence can say *why* nothing happened for 400 ms (`pre-move`, `dwell`, `hold`,
  `double-click-gap`, `think`, `notice-typo`, `pre-scroll`, `burst-pause`, `overshoot-return`,
  `after-navigation`, `between-form-keys`). A dispatcher may skip them.
- **Mouse steps** carry every field of `Input.dispatchMouseEvent` except `pointerType` (always
  `'mouse'`; the dispatcher adds it or relies on the CDP default). `button` on a `mouseMoved` is the
  held button (`'none'` when nothing is held) and `buttons` the held mask on every event; a release
  reports `buttons: 0`.
- **Key steps** omit what is not known — a character with no US key has no `code` and no virtual key
  code — rather than inventing a value. `location` (1 left, 2 right) appears on modifier keys
  (Shift, Control, Alt, Meta); it is a real `Input.dispatchKeyEvent` parameter and the dispatcher
  should pass it through, because a real Shift keydown reports `location` 1 or 2, never 0.
- **`end`** is where the pointer rests afterwards; the dispatcher persists it per tab. Keyboard plans
  do not touch the pointer and have `end: null` (or the `from` passed in).
- **`meta`** always has `kind`, `profile` (the profile's name) and `seed` (as given to `createRng`),
  plus planner facts: `target`/`press` for a click (re-check obstruction at `press`, the point the
  button actually goes down on), `distance`/`fittsMs`/`movementMs`/`overshoot` for moves,
  `deltaX`/`deltaY`/`notches`/`overshoot` for a scroll, `chars`/`keystrokes`/`typos` for typing.

Helpers: `validatePlan(plan)` lists structural problems (a dispatcher can refuse a corrupt plan before
sending anything); `effectiveText(plan)` is the text a keyboard plan leaves in a plain field
(Backspaces applied, Enter as `\n`); `sequence([a, b, …], { gapMs })` joins plans in time;
`planGap(rng, profile, { after: 'action'|'navigation'|'formKey' })` is a think-time gap as a plan.

---

## The model

### Randomness and reproducibility

`createRng(seed)` is mulberry32 seeded from a number (an integer in [0, 2³²) is used as is) or a
string (hashed). There is no default seed — a clock-seeded generator would quietly make
reproducibility false — so a missing seed throws. A BigInt seed is taken as its decimal string
(JSON cannot carry a BigInt, and the seed is written into every plan and run record). Helpers:
`int(a, b)` (both ends inclusive), `range(a, b)`, `normal(mu, sigma)` (Box–Muller),
`logNormal(median, sigma)`, `pick(arr)`, `chance(p)`, `sign()`, and `fork(label)`, an independent
generator derived from the current state
(the parent does not advance). Plans consume the generator they are given, so the order of planning
is part of the seed's meaning: plan a run's actions in the same order and the run replays exactly.

### Pointer

**Where the pointer starts** — it never teleports. Each tab keeps a pointer position
(`extension/lib/pointer.js`, across service-worker restarts); on first use it is a random point in the
middle 60 % of the viewport (`plan.js`), and every action starts where the last one ended.

**Where to aim** — `pickTargetPoint`. Not the centre: a 2-D Gaussian around the centre with
σ = 15 % of the box's width/height, truncated to the inner 70 % of the box and to its part inside the
viewport. When the centre itself is off-screen, the Gaussian is centred on the visible part. A box
with nothing visible cannot be aimed at: the planners refuse it (below).

**The path** — a cubic Bézier from the pointer to the aim point. Control points sit 30–40 % and
60–70 % of the way along, pushed perpendicular by 10–25 % of the distance; each side is chosen at
random (`sameSideChance` 0.5 = independent signs), so paths are arcs and gentle S-curves,
never straight lines.

**How long** — Fitts' law, `MT = a + b·log2(D/W + 1)` with a = 120 ms, b = 150 ms/bit and W the
smaller side of the target (24 px when unknown), clamped to 150–1200 ms, then × the profile's
`durationScale` (the "speed factor": human 1.0, stealth 1.1) × uniform(0.85, 1.15). Far and
small is slow; near and large is quick.

**How it unfolds in time** — minimum jerk, `s(τ) = 10τ³ − 15τ⁴ + 6τ⁵`: the bell-shaped velocity of a
human reaching movement — slow start, fast middle, slow arrival. One `mouseMoved` every 8–16 ms
(jittered per sample); the movement ends on the first sample at or after MT, so every interval is a
real sample interval. Intermediate samples get Gaussian tremor (σ 0.7 px); the last sample is exactly
the aim point. Samples that did not move are dropped — a mouse reports movement, not stillness.

**The pixel grid.** A real mouse moves in whole *device* pixels, so on a 125 % display its CSS
coordinates are multiples of 0.8, never 101.0 (= 126.25 device px). Every coordinate is snapped to
1/dpr of the viewport passed in (`viewport.dpr`, or `devicePixelRatio`/`deviceScaleFactor`);
without it, integers. **G9 3.0.1 does not pass it yet:** `tools/interact.js` `layoutViewport()`
returns `{ width, height }` only, so delivered coordinates are whole CSS pixels. That is correct only
at 100 % display scaling. The change was left out on purpose, because it alters replay determinism
and the unit baselines.

**Overshoot** — moves longer than 400 px overshoot with probability 0.6 by 3–8 % of the distance
along the path direction, then correct in 80–200 ms.

**Idle, dwell, settle** — 50–250 ms idle before a move; on arrival a 60–200 ms dwell before any
press; during it, with probability 0.3, a 1–3 px settle drift that stays inside the aim region.

**Clicks** — press, hold 60–140 ms, release at the same point. Rarely (probability 0.1) the hand moves
one device pixel while the button is down — never more, or the browser starts a drag. Double click:
the second press 90–180 ms after the first release, `clickCount` 1 then 2 (triple: 3). Right and
middle clicks use the same timings. With modifiers (Ctrl+click), the modifier keys go down before the
movement and up after the release, so every mouse event reports a modifier that really is held.

**Drag** — move to the source, dwell, press, hold 80–150 ms, carry along a path 1.5 × the Fitts time
with at least 12 `mouseMoved` samples (left button held on each — HTML5 DnD and pointer-capture
libraries ignore a jump), hold 50–120 ms, release on the drop point. No overshoot on the carry:
sweeping past the drop zone would fire `dragenter`/`dragleave` on its neighbours.

**Off-screen targets are refused.** A path to a point outside the viewport would have to jump from the
edge — exactly the teleport this library exists to prevent. `planMove`/`planClick`/`planHover`/
`planDrag`/`planScroll` throw a `RangeError` ("… is outside the viewport … scroll it into view first
(planScroll)"). The rule: off-screen targets are reached by scrolling first, never by
`scrollIntoView` at the human levels. A remembered pointer position that is outside the viewport
(the window shrank) starts at the nearest edge instead: the pointer re-enters the page there.

### Wheel — `planScroll`

Whole notches of `notchPx` (100 px: Chrome on Windows at the default 3-line setting) at the pointer
position, 40–120 ms apart, in bursts of 2–5 with 150–600 ms between bursts; per burst, with
probability 0.5, the resting hand drifts the pointer 2–6 px (pulled back toward the start so a long
scroll does not walk away). The drift happens inside the idle time before a notch; it never delays
the notch, so the cadence stays within `notchIntervalMs`. With probability 0.4 the scroll overshoots
by one short burst (1–2 notches) and comes back.

- The deltas add up to the request **exactly**. A request that is not a whole number of notches puts
  the remainder in the last notch (a wheel cannot do that; pass `snap: true` to round the request to
  whole notches when the exact amount does not matter). The overshoot is compensated inside the plan.
- `room: { up, down, left, right }` — how far the page can still scroll. Give it when known: an
  overshoot into the end of the page scrolls nothing, and its scroll-back would then move the page
  *back*. With `room`, no overshoot is planned that does not fit. `overshoot: false` disables it,
  `overshoot: true` forces it.
- Vertical notches first, then horizontal. `modifiers` presses the modifier keys around the scroll.
- Signs are CDP's: `deltaY > 0` scrolls down.

### Keyboard

**Key tables** — `keyDefinition(char | keyName) → { key, code, keyCode, text?, shift, location? }`,
moved here from `tools/interact.js` and extended. Every printable ASCII character has its US-QWERTY
physical key: `'1'` is `Digit1`, `'!'` is `Digit1` with Shift, `'A'` is `KeyA` with Shift, `' '` is
`Space`. Named keys: Enter, Tab, Escape, Backspace, Delete, Insert, the arrows, Home, End, PageUp,
PageDown, Space, F1–F24, Shift, Control, Alt, Meta, CapsLock, NumLock, ScrollLock, Pause,
PrintScreen, ContextMenu — case-insensitive, with aliases (Esc, Return, Del, Up, PgDn, Ctrl, Cmd,
Option, …). `\n` and `\r` are Enter (text `"\r"`), `\t` is Tab. One user-perceived character
written as several code points (`é` as e + ◌́, a flag, a skin-toned emoji) is text, up to
Chromium's cap of 4 UTF-16 units per key event. An unknown DOM key name (`AudioVolumeUp`) passes
through with `code` = the name, as in v1. Anything else (`"Ctrl+Shit+K"`, `"hello"`,
`"constructor"`) is not a key: it comes back with no text and no code, `isKnownKey()` is false for
it, and `planKeyPress` refuses it with a `TypeError` rather than pressing a key that does not exist. `code: ''` and `keyCode: 0` mean
"unknown"; `physicalKey(def)` emits them only when known — a fabricated keyCode is worse than none.

**Typing** — `planType(rng, profile, { text, field: { password, numericMask }, typos? })`:

- a 300–900 ms think pause before the first key;
- per character `keyDown` (with `text`/`unmodifiedText`) → hold → `keyUp`; holds are log-normal
  (median 85 ms, σ 0.3, 30–250 ms);
- inter-key interval (keyDown to keyDown) log-normal, median 140 ms (`stealth` 160), σ 0.35,
  × 1.6 after a space or punctuation, × 2.0 before a character that needs a fresh Shift press;
- Shift: `rawKeyDown Shift` → 30–90 ms → the character … its keyup → 20–80 ms → `keyUp Shift`, held
  across a run of shifted characters, pressed with the hand opposite the character (right Shift for
  a left-hand key — `code: 'ShiftRight'`, `location: 2`);
- plain characters may overlap (the next keydown before the previous keyup), as they do for anyone
  typing at speed; never around Shift, Enter, Tab or Backspace — and never the SAME physical key,
  whatever the text ("ll", "ee", "00", a typo followed by its own correction, an A-B-A run): a key
  that is still held cannot go down again, which is what the planner used to do in 36 % of
  `committee` plans at human (interaction review, 2026-09-22), producing keydown, keydown, keyup,
  keyup for one key with `repeat:false` — something no keyboard can send;
- typos at the profile's rate (1 %, `stealth` 1.5 %) on letters and digits: a QWERTY neighbour of the
  same case, 1–2 more correct characters, a 250–500 ms pause, Backspaces, the retype. The continued
  characters are printable ASCII only — never across a line break or Tab (which would submit the
  form or leave the field) and never past an emoji (Chrome's Backspace removes a whole grapheme, so
  the planned Backspaces would remove a correct character too many). **Never** in a password field,
  never in a masked numeric field, never with `typos: false`;
- **invariant:** `effectiveText(plan) === text` (line breaks normalised to `\n`) — typos included.

**Characters with no US key** (Persian, emoji, accented letters) are typed as
`rawKeyDown(key)` → `char(text)` → `keyUp(key)` with **no `code` and no virtual key code**. That is
the event shape Windows produces for Unicode injected with `KEYEVENTF_UNICODE` (the VK_PACKET path of
on-screen keyboards and remote tools): keydown, keypress, input, keyup, no physical key. It is what a
page can honestly be shown without guessing the person's layout. Text is split by **code point**:
Chromium caps a key event's text at 4 UTF-16 units, so a ZWJ emoji sequence sent as one event would be
truncated; sent per code point it assembles in the field exactly as typed.

**Key presses and chords** — `planKeyPress(rng, profile, { key, modifiers = [], repeat = 1 })`. `key`
may be a chord string (`"Control+Shift+K"`, `"Control++"`); `modifiers` a list of names or a CDP mask.
Modifiers go down one by one (Control first, Shift last), each keydown carrying the modifiers held so
far; under a **command** modifier (Control, Alt, Meta) the main key is a `rawKeyDown` with **no
text** — or the page receives a literal character instead of the shortcut — then everything is
released in reverse. Shift alone is not a shortcut: `Shift+a` is `keyDown` "A", `Shift+Enter` a
line break, `Shift+1` "!" — the rule Chromium's own key handling (and Puppeteer's keyboard) follows.
A modifier pressed as the main key (`"Control+Shift"`) carries its own bit on its keydown, as a real
one does. In a chord the Shift state comes only from the modifier list: `"Control+S"` is Ctrl+s,
never Ctrl+Shift+s. A plain key is `keyDown` (with text when it has one) → hold → `keyUp`; a
shifted character on its own (`'!'`) is typed with Shift, as `planType` would; a character with no
US key (`'ش'`) has `planType`'s `rawKeyDown` → `char` → `keyUp` shape. A key the tables do not know
is a `TypeError` (see the key tables above). Text belongs in `planType`.

### Gaps between actions

`planGap`: 200–900 ms between actions, 600–1500 ms after a navigation completed, 80–250 ms between the
keys of one form. The interaction layer decides where a gap belongs.

### `off` — v1's direct dispatch

`off` has `direct: true`: every planner emits what v1 dispatched, so `off` is a regression-safe
fallback and a speed mode.

| Action | Plan |
|---|---|
| click | `mouseMoved` at the box centre (`button:'none'`, `clickCount:1`), then `mousePressed`/`mouseReleased` with `clickCount` 1…n — all at `at: 0`, coordinates unrounded |
| hover / move | one `mouseMoved` (`clickCount: 1`, as every event of v1's `mouse()` had) |
| drag | move, press, 12 linear moves 16 ms apart, release at 192 ms |
| scroll | one `mouseWheel` with both deltas |
| type | per character `keyDown` (text) / `keyUp` with `modifiers: 0` and no Shift key; a shifted symbol (`!`, `{`) carries no physical key, exactly as v1 sent it (`Digit1` without Shift would describe `1`); `delayMs` (default `keyboard.directDelayMs` = 12, v1's) after each character except after a line break (v1 pressed Enter with no delay) |
| key | the main key only, with the modifier mask, `keyDown` when it has text and no modifiers, else `rawKeyDown` (Shift included: `off` keeps v1's rule) |

One deliberate difference from v1, in the key tables: `\t` is the Tab key (`code: 'Tab'`, keyCode 9)
rather than a key named `"\t"`. `tools/interact.js` sends the same on its own direct path.

---

## Every parameter

Ranges are `[min, max]`, drawn uniformly (integer milliseconds unless stated). "stealth" lists only
what differs from human. `off` copies the human numbers but ignores them (`direct: true`), and it
also sets `keyboard.typoRate` to 0. Only `keyboard.directDelayMs` is used at `off`. Every value
below was checked against `extension/humanize/profiles.js` on 2026-09-22.

| Parameter | human | stealth | Meaning |
|---|---|---|---|
| `format` | 1 | | profile format version |
| `name`, `level`, `direct`, `description` | | | identity; `level` is off/human/stealth; `direct` only for off |
| `base` | — | | the profile this one was merged onto (team profiles) |
| `calibration` | — | | fit record: base, recordings, events, samples, fitted and kept parameter paths |
| **mouse** | | | |
| `mouse.durationScale` | 1.0 | 1.1 | the speed factor: multiplies the Fitts time (higher = slower) |
| `mouse.fitts.a` / `.b` | 120 / 150 | | Fitts intercept (ms) and slope (ms per bit) |
| `mouse.fitts.minMs` / `.maxMs` | 150 / 1200 | | clamp on the Fitts time, before scale and jitter |
| `mouse.durationJitter` | [0.85, 1.15] | | per-move multiplier (real, uniform) |
| `mouse.sampleIntervalMs` | [8, 16] | | time between `mouseMoved` samples |
| `mouse.jitterPx` | 0.7 | | σ of the Gaussian tremor on intermediate samples (px) |
| `mouse.curvature.along1` / `along2` | [0.30, 0.40] / [0.60, 0.70] | | control points as fractions of the segment |
| `mouse.curvature.offset` | [0.10, 0.25] | | perpendicular push, fraction of the distance |
| `mouse.curvature.sameSideChance` | 0.5 | | both control points on the same side (0.5 = independent signs) |
| `mouse.overshoot.minDistance` | 400 | | px; shorter moves never overshoot |
| `mouse.overshoot.chance` | 0.6 | | probability for a long move |
| `mouse.overshoot.fraction` | [0.03, 0.08] | | overshoot length, fraction of the distance |
| `mouse.overshoot.correctionMs` | [80, 200] | | duration of the correcting segment |
| `mouse.preMoveMs` | [50, 250] | | idle before a move |
| `mouse.dwellMs` | [60, 200] | | on arrival, before a press |
| `mouse.settle.chance` / `.px` | 0.3 / [1, 3] | | settle drift during the dwell |
| `mouse.pressHoldMs` | [60, 140] | | press → release |
| `mouse.releaseDrift.chance` / `.px` | 0.1 / 1 | | movement while the button is down (px ≤ 1, enforced) |
| `mouse.doubleClickGapMs` | [90, 180] | | first release → second press |
| `mouse.defaultTargetPx` | 24 | | Fitts W when the target size is unknown |
| `mouse.target.sigma` / `.inner` | 0.15 / 0.70 | | aim Gaussian σ (fraction of size) and the inner fraction it is truncated to |
| **drag** | | | |
| `drag.pressHoldMs` | [80, 150] | | press → start of the carry |
| `drag.durationFactor` | 1.5 | | carry time = factor × Fitts time |
| `drag.minSamples` | 12 | | fewest `mouseMoved` in the carry |
| `drag.releaseHoldMs` | [50, 120] | | end of the carry → release |
| **wheel** | | | |
| `wheel.notchPx` | 100 | | px per notch |
| `wheel.preMs` | [40, 160] | | idle before the first notch |
| `wheel.notchIntervalMs` | [40, 120] | | between notches of a burst |
| `wheel.burst` | [2, 5] | | notches per burst (integers) |
| `wheel.burstPauseMs` | [150, 600] | | between bursts |
| `wheel.drift.chance` / `.px` | 0.5 / [2, 6] | | pointer drift per burst |
| `wheel.overshootChance` | 0.4 | | scroll past and back |
| `wheel.overshootNotches` | [1, 2] | | size of the overshoot burst |
| **keyboard** | | | |
| `keyboard.ikiMedianMs` / `ikiSigma` | 140 / 0.35 | 160 / — | inter-key interval, log-normal median and σ of ln |
| `keyboard.ikiMs` | [35, 1500] | | clamp on one sampled interval |
| `keyboard.afterSpaceOrPunct` | 1.6 | | interval multiplier after a space or punctuation |
| `keyboard.beforeShifted` | 2.0 | | multiplier before a character that needs a fresh Shift |
| `keyboard.thinkMs` | [300, 900] | | before the first key of a field |
| `keyboard.shiftLeadMs` / `shiftTrailMs` | [30, 90] / [20, 80] | | Shift down → character; character up → Shift up |
| `keyboard.holdMedianMs` / `holdSigma` / `holdMs` | 85 / 0.3 / [30, 250] | | key hold, log-normal, clamped |
| `keyboard.rollover` | true | | plain keys may overlap |
| `keyboard.typoRate` | 0.01 | 0.015 | per typeable character |
| `keyboard.typoContinue` | [1, 2] | | correct characters typed before the typo is noticed |
| `keyboard.typoNoticeMs` | [250, 500] | | pause before the Backspaces |
| `keyboard.backspaceFactor` | 0.8 | | Backspace interval = interval × this |
| `keyboard.chordGapMs` | [30, 90] | | between the keys of a chord |
| `keyboard.directDelayMs` | 12 | | `off` only: v1's per-character delay |
| **gaps** | | | |
| `gaps.betweenActionsMs` | [200, 900] | | think time between actions |
| `gaps.afterNavigationMs` | [600, 1500] | | after a navigation completed |
| `gaps.betweenFormKeysMs` | [80, 250] | | between the keys of one form |

`PROFILE_SCHEMA` (profile.js) holds the sanity bounds of each value — "a person could plausibly do
this" — and `validateProfile` checks the shape, every bound, unknown keys (a typo such as `fitss` is
an error, not ignored — and so is a `"__proto__"` key in stored JSON, which is kept as data and reported
rather than allowed to swap the object's prototype) and the cross-field rules (`level` and `direct`
agree — `off` is the one direct level; `fitts.minMs ≤ maxMs`; `along1` ends before
`along2` begins).

---

## The profiles

| Profile | For |
|---|---|
| `off` | v1's direct dispatch. Fastest, deterministic, obviously synthetic. Use for suites where input realism is irrelevant, or to rule humanize out when a test fails. |
| `human` | The default input level: the defaults of this file. |
| `stealth` | Detector-sensitive runs: 10 % slower pointer, slower typing (median 160 ms), 1.5 % corrected typos. Pair it with the stealth *environment* (docs/STEALTH.md) — behaviour alone does not make a run undetectable. |

`resolveProfile(nameOrObject, overrides?, library?)` returns a frozen, validated profile:

- a built-in name; `null`/`undefined` means `'human'`;
- a name found in `library` (name → profile object) — the caller loads stored team profiles and passes
  them; the library keeps no registry and does no I/O;
- an object: merged onto its `base` (else `extends`, else a built-in of the same name, else `human`),
  so a team profile needs to contain only what differs;
- `overrides` are deep-merged last (arrays — the ranges — are replaced, not merged).

An unknown name throws; an invalid result throws with **every** problem listed.

---

## Calibration

`fitProfile(rawEvents, base = 'human', { name }?) → { profile, samples, report }` fits a profile from
recordings of a real person. The rule that shapes it: **never fabricate**. A parameter is
fitted only from enough samples of the thing it describes (`MIN_SAMPLES`), otherwise it is kept from
the base and the report says which and why. A biased sample is not a sample: the time between two v1
clicks mixes thinking with moving, so it does not become think time just because it is the only
number there.

**Input.** One recording (an array of events), several (an array of arrays), or objects carrying the
events (`{ raw }`, or the recorder's `{ format: 'g9-input-samples/1', events }`). Each event is
`{ type, at, … }`:

| Source | Types | Used for |
|---|---|---|
| v2 recorder samples (`tools/record.js`, stored as `input-samples.json`) | `mousemove {x,y}` (at most one per 16 ms), `mousedown {x,y,button,detail,width,height}`, `mouseup`, `wheel {deltaX,deltaY,deltaMode}`, `keydown`/`keyup` with the key reduced to its class (`a`, `A`, `!`, `.`, `' '`, named keys) and an opaque pairing `code` — the rhythm, never the text; nothing inside password fields | everything below |
| v1 recorder | `click`/`dblclick`/`rightclick`, live `change {value}` (one per keystroke), notable `key`, `navigate`, … | typing rhythm, think time before typing, correction rate, Tab gaps (the key source is decided per recording, so v1 and v2 recordings can be fitted together) |
| also accepted | `pointermove`/`pointerdown`/`pointerup` (non-mouse pointer types are ignored), `input`, `rect`/`w,h` sizes | |

**What is fitted, and how.**

| Parameters | From |
|---|---|
| `keyboard.ikiMedianMs`, `ikiSigma` | log-normal fit of plain→plain inter-key intervals (≤ 2 s; nothing across a click) |
| `keyboard.afterSpaceOrPunct`, `beforeShifted` | median of each class ÷ the plain median; an interval carrying both effects belongs to neither |
| `keyboard.holdMedianMs`, `holdSigma` | keydown→keyup pairs (needs key-up events) |
| `keyboard.shiftLeadMs`, `shiftTrailMs` | Shift down → character; character up → Shift up |
| `keyboard.thinkMs` | click (or press/release) → first keystroke; a keystroke starts at its first key, the Shift for a capital |
| `keyboard.typoRate` | correction runs (Backspace runs, or value shrinking) per typed character — an **upper bound**: deliberate edits count too |
| `gaps.betweenFormKeysMs` | Tab → next keystroke (from its Shift, when it has one) |
| `mouse.fitts.a`, `.b` (+ `durationScale` = 1) | least squares of movement time on log2(D/W + 1); W from the press's target size (else 24 px, and the report says it was assumed); refused when non-physical or when the movements do not vary enough in difficulty |
| `mouse.durationJitter`, `fitts.minMs/maxMs` | residual ratio spread; the clamps widen when observed movements fall outside |
| `mouse.curvature.offset`, `sameSideChance` | a least-squares Bézier fit of each non-overshooting path ≥ 100 px: with control points near ⅓ and ⅔ the along-path fraction is the Bézier parameter, so the perpendicular offset is linear in the two control offsets |
| `mouse.overshoot.chance`, `fraction` | long movements whose path goes > 1.5 % past the target |
| `mouse.sampleIntervalMs` | move-to-move intervals — **refused** when no two moves are closer than ~16 ms (the v2 recorder's throttle, not the mouse) |
| `mouse.dwellMs`, `settle.chance` | arrival → press; dwells with a settle drift (a lower bound: a settle within 30 ms of arrival merges into the approach) |
| `mouse.pressHoldMs`, `doubleClickGapMs` | down → up of presses that did not travel (> 2 px before the release is a drag — a text selection, a slider — whose hold is the carry, not a click); up → down with `detail` 2 |
| `gaps.betweenActionsMs`, `afterNavigationMs` | the idle before a movement (from the latest release, key, wheel notch or navigation), minus the base pre-move idle (the two cannot be told apart) |
| `wheel.notchPx` | the dominant pixel delta, only when ≥ 60 % of events share it (a touchpad or smooth-scrolling mouse does not) |
| `wheel.notchIntervalMs`, `burst`, `burstPauseMs` | a two-cluster split of each recording's wheel intervals (log scale) into within-burst and between-burst; a recording with too few intervals to split contributes no cadence (its pauses would read as notch intervals) and no bursts |
| `wheel.overshootChance` | scroll episodes that end with a short reversal |

Ranges are the 5th–95th percentiles of the samples. How a movement is found: the pointer history
since the last press/release is cut into stretches of motion at every stillness (> 100 ms); trailing
stretches that shift the pointer ≤ 3.5 px are the dwell's settle; the stretch before them is the
approach, starting where the pointer rested.

**Output.** `profile` is complete and validated, named `name` (default `<base>-calibrated`), with
`base` set and a `calibration` record (samples, fitted and kept paths). `samples` counts what each fit
saw. `report` is plain text for a person, one line per parameter:

```
Calibration of "team-qa" from 3 recordings, 14171 usable events (base: human).
28 parameters fitted; everything else is the base profile's.
Keyboard (from keydown/keyup events)
  keyboard.ikiMedianMs = 209  (log-normal median of 2243 intervals)
  …
  kept gaps.betweenFormKeysMs — 0 Tab→next-key gaps (need 5)
Pointer (from pointer paths)
  mouse.fitts.a = 96  (least squares, 120 movements)
  kept mouse.sampleIntervalMs — no two moves were recorded closer than ~16 ms — the recorder throttles …
```

The unit tests prove the round trip: recordings synthesised from a known profile fit back to it
(inter-key median within 10 %, Fitts b within ±25 ms/bit, curvature, holds, dwell, wheel cadence and
notch size), and the recorder's exact sample shape is read correctly.

---

## Adding a team profile

**From recordings (the normal way).**

1. Record a few ordinary flows in the side panel with the people whose hands you want — several
   minutes of real use across forms, lists and scrolling pages. The recorder samples pointer paths,
   presses, wheel notches and key *timing* alongside the steps (nothing in password fields, no text).
2. Fit and save: `browser_recording action:"calibrate_humanize" id:"<recording id>" name:"team-qa"`
   (`ids:[…]` fits one profile from several recordings; `base` picks the built-in to start from).
   Read the report: every kept parameter says what was missing. (The side panel's "Calibrate" button
   is a different thing — it marks replay noise; there is no panel button for this yet.)
3. Use it by name: `humanize: "team-qa"` on an action, a replay, a runner suite (`--humanize
   team-qa`) or a schedule entry. Saved profiles are stored under `humanize:profile:<name>` in an
   engine's storage (`extension/lib/humanize.js` `saveProfile`/`loadProfile`), and `levelFor`
   resolves an unknown name there. Where the profile ends up depends on where it was fitted
   (`daemon/router.js`):
   - **Fitted from a recording in the extension:** saved in the extension's store **and** the
     launched-engine store, so the name works in both.
   - **Fitted from a recording in a launched engine:** saved in the launched-engine store only. G9
     3.0.1 has no message that installs it into the extension, so `humanize:"team-qa"` in the
     person's own browser fails with "Unknown humanize profile".

   Without `name`, the fitted profile is returned and nothing is saved. A name must be 1–64 letters,
   digits, `.`, `_` or `-`, and cannot be `off`, `human` or `stealth` in any letter case.

**By hand.** Write only what differs, on a base:

```json
{ "name": "team-slow-typists", "base": "human",
  "keyboard": { "ikiMedianMs": 210, "typoRate": 0.02 },
  "wheel": { "notchPx": 120 } }
```

`resolveProfile(thatObject)` validates it and fills the rest from the base. There is no tool that
saves a hand-written profile in 3.0.1: the MCP `humanize` argument takes only a level or a saved
name. Code that runs inside an engine can call `saveProfile(name, thatObject)`, which validates the
profile and stores it where `levelFor` finds it. Do not add team profiles to `profiles.js`:
`PROFILES` is the three built-in levels of the contract, and a team's hands are data, not code.

---

## Delivered timing (measured)

Plans are exact. What reaches the page also depends on the browser's frame rate and on how fast
each CDP command returns. The numbers below were read by **page-side listeners** (event
timestamps, not G9's own report) on the owner's workstation on 2026-09-22, with Windows 11, Edge
153.0.4234.32, Chrome 153.0.8010.53 and Chrome for Testing (CfT) 153.0.8010.52. The run names are
the ones `docs/STEALTH.md` defines:
- **live round 2**: before the fixes;
- **live round 3**: after them;
- **this guide's run**: one `setup/stealthtest.mjs --local-only --browser edge` run, headless,
  stealth.

**Pointer cadence** is the median gap between the page's `mousemove` events. The plans sample
every 8–16 ms.

| Browser | Live round 2 | After the fixes |
|---|---|---|
| Edge | 10.9–11.8 ms | 11.1–12.2 ms (live round 3); 11 ms, p10 5.6, p90 16.8, n = 367 (this guide's run); 10.6–10.9 ms (2026-09-23) |
| Chrome | 13.9 ms | not re-measured |
| CfT | **100.4–100.6 ms**: 10 Hz, headless and headed, even on a fresh single-tab profile | 16.8–17.2 ms (live round 3); 17.2–17.4 ms with the switch, 100.5 ms without it (2026-09-23) |

CfT's renderer ran `requestAnimationFrame` every 100.5 ms against 10.5 ms for Edge and Chrome.
Input is frame-aligned, so humanized paths arrived as 10 Hz jumps. Each `mouseMoved` took 35–54 ms
to dispatch (Edge 7–16 ms, Chrome 7.6 ms), and a humanized click took 3,473–5,213 ms on CfT against
629–1155 ms on Edge (live round 2). G9 passes `--disable-frame-rate-limit` to CfT only
(`engine/launch.js` `KIND_SWITCHES`; measured rAF 17.4 ms, 7.7 ms per dispatch). A person's own CfT
under Engine 1 has no such switch, and a humanized path reached the page there as 4–5 mousemoves,
against 17–23 on Edge (live round 3).

**Re-checked 2026-09-23, and why the switch stays.** The owner allowed the Windows Firewall prompt
that had been pending for the newly installed `chrome.exe` during live round 2, so the cadence was
measured again. Two sequential probe runs read CfT *without* the switch at 10.1 ms — as fast as Edge
— which would have meant the 10 Hz was the pending prompt. An interleaved A/B settled it: 4 rounds,
each launching CfT+switch, CfT alone and Edge alone back to back on fresh temp profiles, same GPU
(ANGLE/NVIDIA) in all 12 launches.

| 4 rounds, one line each | rAF | page mousemove | press hold | per dispatch |
|---|---|---|---|---|
| CfT + `--disable-frame-rate-limit` | 17.3–17.4 ms | 17.2–17.4 ms | 25.7–59.3 ms | 17.3 ms |
| CfT, nothing added | 100.5–100.6 ms | 100.5 ms | 1.4–3.1 ms | 100.5 ms |
| Edge, nothing added | 10.5 ms | 10.6–10.9 ms | 106–108 ms | 10.3–10.4 ms |

CfT's 10 Hz reproduces in 8 launches out of 8 in a quiet machine state; the switch pins the cadence
to 17.4 ms in 12 out of 12. The two 10.1 ms readings came from a window in which the machine had
been running browser suites continuously for half an hour, and could not be reproduced afterwards.
The press hold in the table is short because that probe dispatches on the plan's raw schedule and
each dispatch costs 17.3 ms; it is `perform` rule 1 (the 80 % rule) that brings the product's own
hold back to 60–151 ms.

**Moves per click** (Engine 1, Edge, live round 3): `off` sends 1 trusted mousemove, `human` 17–19
and `stealth` 23. Each delivered exactly one trusted click.

**Press hold** is mousedown → mouseup by event timestamp. The plan draws 60–140 ms.

| Where | Hold seen by the page |
|---|---|
| Live round 2, Edge (healthy runs) | 64–141 ms, median 92–111 ms |
| Live round 2, CfT | **1.9–8.1 ms in 20/22 runs**: the dispatcher had fallen behind, and press and release went out back to back |
| After the 80 % rule (`perform` rule 1), fix-round final code | CfT 59–106 ms, Edge 91–137 ms |
| Live round 3, stealth suite | Edge headless 60.1–140.8, headed 76.3–142.0, `de-DE` 61.4–107.0; CfT headless 77.6–151.1, headed 60.5–137.5 ms |
| Engine 2 live test, 8 full runs | human 77–138 ms, stealth 61–139 ms, `off` 1.5–2.6 ms |
| Engine 1 (extension, Edge), 9 runs | human 118.9–128.7 ms, stealth 122.1–139.7 ms, `off` 2.6–3.5 ms |
| This guide's run | 62.3 ms |

The rule protects the hold from below only: a planned 60–140 ms hold cannot fall under 48–112 ms. A
slow release can still make it longer than planned, as with CfT's 151 ms.

**Pressure.** In live round 2, `pointerdown.pressure` was 0 in 50/50 runs: CDP's `force` defaults to
0, which Blink passes through. Since G9 sends `force: 0.5` while a button is held, the page reads
0.5 on `pointerdown`, 0 on `pointerup`, and 0 on idle moves, at every level including `off`. This
held in every run of the Engine 2 live test, the Engine 1 live suite (9 final runs) and the stealth
suite, and in this guide's run.

**Typing** (median interval between keydowns; the profile median is 140 ms, 160 ms at stealth):
- Engine 2 live test, 26 characters: human 121–154 ms, stealth 139–170 ms, `off` 30 ms.
- Stealth suite, live round 3: medians 123.7–201 ms (coefficient of variation 0.36–1.07), with key
  hold medians of 76–110 ms.
- This guide's run: 152.8 ms, with a hold median of 92.8 ms.

Before the 80 % rule relaxed an earlier 100 % rule, the carried-over dispatch time had slowed Engine 2
typing from a median of 141–156 ms to 173–199 ms (`extension/lib/humanize.js`).

**Wheel.** Notches are 100 px, `deltaMode` 0 and trusted. The median notch interval was 79–123 ms on
Edge and 102–203 ms on CfT in live round 2, 82–123 ms in live round 3, and 93.5 ms over 37 notches in
this guide's run.

**Scroll settle.** In live round 2, at least one of 4 humanized scroll calls returned while a notch
was still to land, in all 50 runs; the next action then aimed at stale geometry. On CfT, 22/22
hovers and clicks right after a scroll missed, each reported "delivered". Since the fix:
- 0 scroll events arrived after any of 216 scroll calls returned (live round 3);
- the reported position equalled `scrollY` right after the call and 800 ms later (Engine 2 live test).

**A page that cancels `pointerdown`** gets `pointerdown`, `pointerup` and `click`, but no
`mousedown` (the Pointer Events rule). G9 reports that click as delivered at every level. This held
in every run since the fix; before it, G9 called it not delivered in 22/22 runs.

**Another agent reading the same tab** does not change the timing. With snapshots from a second
agent every ~100 ms, the same seeded human click took 941–1016 ms, against 938–964 ms alone (Engine
2 live test).

---

## Honest limits

- **A model, not a person.** The distributions are simple (uniform ranges, one log-normal, one Bézier
  with at most one overshoot). Real paths have several corrective sub-movements, hesitations and
  tremor at 8–12 Hz; ours has white Gaussian tremor. A detector trained on many sessions of the same
  person can still separate them. Calibration narrows the gap; it does not close it.
- **Sample timing.** Moves come every 8–16 ms with jitter; a real mouse reports at a fixed rate (125,
  500 or 1000 Hz) and the browser coalesces. The page sees exactly one `pointermove` per dispatched
  move, and `getCoalescedEvents()` always has length 1 (live round 3, 14/14 runs): a weak CDP-class
  signal that no public detector was seen to use. The pointer grid is only right when the dispatcher
  passes the page's `dpr`, which 3.0.1 does not (see "The pixel grid"). No pointer-acceleration curve
  is modelled.
- **Dispatch precision is not ours.** A plan says "at 1234 ms"; the dispatcher's timers, a busy
  service worker and each CDP round trip add latency, so the delivered timing is the planned timing
  plus noise. Plans are exact; delivery is not.
- **Keyboard layout.** US QWERTY only. A Persian or German user's keydown carries a physical code for
  every character; ours carries none for non-ASCII (the VK_PACKET shape). IME composition
  (`compositionstart` …) is not modelled.
- **Typos** are adjacent-key substitutions only — no transpositions, omissions or doubled letters —
  and assume the caret is at the end of the field and nothing (autocomplete, maxlength, a key filter)
  intervenes between the wrong key and its Backspace. `field.password`/`numericMask` are the caller's
  facts; a field the caller misjudges gets typos. (The caret really is at the end: `browser_interact
  action:"type"` without `clear` presses End after its own focus click when the field is not empty —
  the click lands at a random point inside the text otherwise, and the text was spliced into the
  middle.)
- **Wheel.** A notched wheel only: no touchpad or smooth-scroll mouse (continuous small deltas). A
  request that is not a whole number of notches ends with a partial notch — an EXPLICIT `amount` from
  an agent is sent exactly as asked, while bringing an element into view and a replay's scroll to a
  recorded resting place round to whole notches. Near the end of a page the overshoot needs `room`,
  or its scroll-back moves the page.
- **The same seed reproduces a plan, not a session.** A plan also depends on where the pointer starts
  (the path's length, its Fitts duration, every later draw) and on the viewport. G9 keeps the pointer
  position per tab, so the same seed on a tab whose pointer is elsewhere gives another path: a replay
  homes the pointer to a seed-derived point before step 1 and reports it as `pointerStart`, and a
  single action reproduces only from the same position.
- **Drag** does not auto-scroll: a drop target below the fold must be scrolled into view first.
- **Calibration** is only as good as what was recorded: v1 recordings have no pointer data (typing and
  think time only); the v2 recorder throttles moves to 16 ms (device rate not identifiable); the
  settle rate is a lower bound; the typo rate an upper bound; Fitts W is the size of the element the
  recorder considers actionable, which is not always what the person aimed at.
- **Behaviour is half of it.** Undetectability also needs a consistent environment (no `Runtime`,
  nothing in the main world, a real warm profile, headed on a dedicated desktop for strict cases) —
  see docs/STEALTH.md. This library cannot fix a browser that looks automated.

---

## Tests

```
node setup/unit/humanize.test.mjs
```

Standalone (ARCHITECTURE_V2 §12.1): no network, browser or port. It checks determinism per seed and
difference between seeds; 2000 random plans across every planner and profile for NaN/Infinity,
structure, grid coordinates, on-screen samples, teleports (≤ 20 px/ms) and clean press/release pairs;
ordinary targets under 10 px/ms; off-screen refusal; the dpr grid; Fitts bounds and the bell-shaped
velocity; aim-point distribution; click, double-click, hover and drag timings; wheel totals, cadence,
drift, overshoot compensation and `room`; `keyDefinition` for all 95 printable ASCII characters and
the named keys; the typing invariant on 500 random strings (shifted symbols, Persian, emoji, line
breaks) in every profile; typo mechanics and their absence in password/masked fields; Shift timing and
side; inter-key statistics; chords (Shift-only chords type, command chords do not, unknown keys are
refused); v1 reproduction by `off`; profile consistency (`level`/`direct`, `__proto__`); calibration
round trips from synthetic
recordings, from the recorder's own sample shape, from v1 events and from nothing; and the purity of
the source. On 2026-09-22 it passed 50 tests in about 2 s; in the unit runs of 2.0.1 (2026-09-23) and
2.0.2 (2026-09-24) it passed 51. `setup/unittest.mjs` runs it with the other suites.

These tests cover the plans only. What a real page receives is measured by the live suites:
- `setup/stealthtest.mjs`: holds, pressure, cadence, typing, wheel and settle on the local detector
  page;
- `setup/engine2-livetest.mjs`: launched engines;
- `setup/isolated-livetest.mjs`: the extension.

"Delivered timing" above gives their numbers.
