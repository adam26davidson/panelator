# Console design: flow and interaction notes (spec 051)

The six screens of spec 051 section 7, as Storybook stories in this directory, each rendered at
mobile (390 × 844), tablet (820 × 1180) and desktop (1440 × 900) by spec 029's renderer. Tokens are
in `tokens.html`; the shared shell, components and fixture snapshot are in `console-kit.tsx`, which
every story imports so the screens use one token set and one shell.

Home follows direction A (delivery-system design section 9): questions banner, one large card for
the running issue with stage progress, model, elapsed and cost, up next, then four stat tiles.

## Screens and their stories

| Screen | Stories (states) |
|---|---|
| Home | Default, Idle, Empty, Loading, Stale, Unreachable, SignedOut, SignInRefusedLogin |
| Questions | Default, NoTelegram, Empty, Loading, Stale, Unreachable, SignedOut |
| History | Default, FromTile, Empty, Loading, Stale, Unreachable, SignedOut |
| Actions | Default, PendingChange, RefusedChange, Empty, Loading, Stale, Unreachable, SignedOut |
| Agents | Default, PendingChange, RefusedChange, Empty, Loading, Stale, Unreachable, SignedOut |
| Parameters | Default, FromAwsTile, PendingChange, RefusedChange, Empty, Loading, Stale, Unreachable, SignedOut |

Every state section 7 names is covered: loading, stale, API unreachable, signed out and empty on all
six screens (Home's empty is an idle system with no questions, no metrics report and the cap at 0);
pending and refused changes on Parameters, Actions and Agents.

## Navigation

- **Mobile (< 720px):** a bottom tab bar with six tabs, Home, Questions, History, Actions, Agents and
  Params (icon above a 14px label, 60px tall). The Questions tab carries the count of open questions.
  In the app the bar is fixed to the bottom of the viewport; a full-page render shows it once, at the
  end of the page. The 44px round account button at the top right opens a sheet with the signed-in
  login and **Sign out**.
- **Tablet and desktop (≥ 720px):** a side rail (208px, 240px from 1200px) with the same six entries,
  the open-question count on Questions, and at its foot the signed-in login and **Sign out**. The
  rail's contents stay in place while the page scrolls.
- The current screen is marked in both (accent colour and weight, plus a top bar on the tab or a
  tinted row on the rail, so it is never colour alone) and carries `aria-current="page"`.
- Each screen has its own URL (`/`, `/questions`, `/history`, `/actions`, `/agents`, `/parameters`),
  so a link from Telegram or GitHub opens the right screen.

## Transitions the spec names

| From | Action | To |
|---|---|---|
| Sign-in | GitHub sign-in succeeds for the maintainer's login | Home, or the screen whose link was opened (the sign-in card says which: "After sign-in you return to Questions") |
| Sign-in | GitHub returns another login, or `state` mismatches | the refusal card (`home--sign-in-refused-login`): no session, offer to sign in with a different account |
| Any screen | Tab bar (mobile) or rail (tablet, desktop) | any of the other five screens |
| Home | Questions banner (only when open questions > 0) | Questions, scrolled to the top of Open |
| Home | Large current card's **PR #n** button | the claim's pull request on GitHub, new tab |
| Home | A compact row of a further running claim | its PR on GitHub, or the issue when there is no PR yet |
| Home | Merged per week, Median issue-to-merge or Rework tile | History, scrolled to that metric's card, outlined for 2 s (`history--from-tile`) |
| Home | AWS spend tile | Parameters, scrolled to `aws_cap_usd`, the row tinted and outlined and its value field focused (`parameters--from-aws-tile`) |
| Questions | **Answer on GitHub**, **Question on GitHub** | the question comment (`question_url`), new tab |
| Questions | **Open Telegram chat** (only when `telegram_url` is present) | the chat with the bot (`https://t.me/<bot>`), new tab or the Telegram app |
| Questions | **Decision record** (answered only) | the reply comment (`decision_url`), new tab |
| Any screen | Session missing or expired (401 from `GET /state`) | the sign-in card naming that screen |
| Any screen | **Sign out** (rail foot or account sheet) | `POST /auth/logout`, then the sign-in card for Home |

## Freshness and failure (AC-14)

- Every screen's header carries a freshness chip beside the title: **Updated 18 s ago** (green dot,
  ok colours), **Stale · 4 min old** (warn colours) once the snapshot is older than three times
  `tick_s`, **Offline · 6 min old** (danger colours) while the API cannot be reached, **Loading**
  (spinner) before the first snapshot. The chip's word says the state, so colour is never alone.
- **Stale** adds a warn banner under the header: how old the snapshot is, that the scheduler pushes at
  least every `tick_s`, the time it is shown as of, and that changes wait in the queue until the
  scheduler reconnects. Controls stay enabled, because `POST /changes` still works.
- **Unreachable** adds a danger banner with the time of the last snapshot kept, "Retrying every 10 s",
  and **Retry now**. The last snapshot stays on screen. Every control that posts a change (Undo,
  Pause/Resume, value fields, Save, mode switch) is disabled until the API answers again, because a
  change could not be sent.
- **Loading** shows the shell (rail or tab bar, header) with grey skeleton blocks shaped like the
  screen's content, so nothing jumps when the snapshot arrives.
- The app polls `GET /state` every 10 s while visible and at once when the tab regains focus; the
  age in the chip counts up every second between polls.

## Per-screen interaction notes

**Home**
- Desktop puts the current card (two thirds) beside Up next (one third) and the four tiles in one row;
  tablet and mobile stack banner, card, further claims, Up next, then tiles 2 × 2.
- Stage progress: one segment per stage of `current[].stages`, coloured done (ok), running (accent),
  failed (danger) or pending (track). From 720px each segment has its label below, the running one
  bold in accent, done ones with ✓, failed with ✕. On mobile the labels are replaced by one caption,
  "implement · stage 2 of 6 · next: verify". A spec or design track shows one segment named for the
  track.
- More than one claim: the oldest gets the large card; the others are compact rows (stage badge,
  issue and title truncated to one line, elapsed · cost · PR) under it.
- Idle: the card says "Nothing is running" with the next tick time from `next_tick_at`.
- Up next shows the first three of `up_next`, numbered, each with its class badge; empty says the
  shortlist is empty.
- Metric tiles show the latest complete week's value with its unit, "week of <Monday>", and a
  sparkline of the last eight weekly buckets (gaps for null buckets, the last point marked). A null
  tile shows "No data" and "No complete week yet".
- AWS tile: actual this month as the value with "of $<cap> cap", the forecast in words, and a meter
  (track = cap, fill = actual, a dark tick = forecast). At cap 0 there is no meter; it reads "cap 0:
  nothing may be launched" with a lock icon.

**Questions**
- Single readable column (max 880px) at every width; open questions first with a count, then answered,
  newest first.
- An open question shows issue link, kind badge (product violet, technical blue, capability amber),
  status (Open, or Reminded in warn colours), when asked (and reminded), the full text, the options
  numbered with their cost, the recommended option marked "recommended", then **Answer on GitHub**
  (primary) and **Open Telegram chat**. The console never answers a question itself (spec 051
  section 2).
- An answered question shows its issue, kind, **Answered** badge, when answered, the text, and links to
  the decision record and the question.

**History**
- Window control: segmented 4 / 12 / 26 / 52 wk, 12 by default; the choice is kept in the URL
  (`?weeks=12`) so a link reopens the same view. Changing it redraws every chart over that many
  weekly buckets; no refetch is needed because the snapshot carries 52 weeks.
- One card per metric of the report, in report order: title, goal badge, description, latest value with
  unit and "lower/higher is better", then a line chart (one y-axis starting at 0, three or four grid
  lines, first/middle/last week labels). A null bucket breaks the line (a gap, never a zero); a lone
  point between gaps gets a dot. The footer names the gap weeks and has a **Table** button that swaps
  the chart for a table of week, value and n, for screen readers and exact values.
- A replaced metric is drawn in its replacement's card: replacement solid in series 1, replaced metric
  dashed in series 2, a legend naming both with "(new)" and "(replaced)", and a note giving the
  replacement date and the overlap days left. When the report stops carrying the old metric, the card
  shows only the new one.
- Hover (pointer) or tap (touch) on a chart shows a dashed crosshair at the nearest week, a dot on each
  series and a tooltip with the week and each value (shown in the default story on the first chart).
  The tooltip flips to the right of the crosshair near the left edge.
- Desktop shows charts two across; tablet and mobile one.

**Actions**
- Newest first, the last 200 from the snapshot. Desktop is a table (When, What and why, Agent, Status,
  Undo); tablet and mobile show each entry as a block with when · agent above, what in bold, why below,
  then status and Undo on one line.
- Status badges: applied (ok), undone (neutral), refused and failed (danger, with the reason under the
  why), pending (accent with spinner). Entries by the maintainer read "you (maintainer)".
- **Undo** appears only when `undo` is not null and the status is applied. Pressing it posts an `undo`
  change at once (no confirm dialog: the undo is itself undoable from the new row it creates). While
  the change is pending the row's badge reads "Undo pending", the button "Undoing…" (disabled), and a
  note says which change id was sent and when. When the outcome arrives: applied turns the row to
  "undone" and the new undo row appears at the top; refused leaves the row applied and shows
  "Undo refused: <reason>" in a danger note under it until the user leaves the screen.

**Agents**
- Desktop table (Agent, Last run, Next run, Cost 30 days, control); tablet and mobile blocks with the
  control at the top right.
- A failed last run is shown in danger colour with the word "failed". A paused agent's next run reads
  "— (paused)" and it carries a badge: "Paused by you" (warn) when `paused_by` is the maintainer,
  "Paused by <agent>" (neutral) otherwise. Resume is the primary button on a paused agent; Pause is a
  secondary button on a running one.
- Pressing Pause or Resume posts the change; the button reads "Pausing…" or "Resuming…" disabled and
  a pending note names the change id. A refusal shows the reason in a danger note and the control
  returns to its previous state.

**Parameters**
- A short legend at the top says what Auto and Locked mean. Desktop table (Parameter with description
  and limits, Value, Mode, Last set); tablet puts value and mode side by side under the name;
  mobile stacks name, value, mode, last set.
- Value control by type: number, duration and string are text fields (duration as `6h`, `30d`);
  booleans are an On / Off segmented control that posts at once. Editing a field outlines it in accent
  and shows **Save**; Enter also saves; Escape or blur without saving restores the stored value. The
  limits are shown beside "Value" (min · max, "on or off", or the type).
- Mode is an Auto / Locked segmented switch (Locked with a lock icon, warn colour when selected). It
  posts `set_parameter_mode` at once. A locked parameter shows "Locked: the system cannot change this.
  You can." under the switch. The maintainer can edit a locked value; only agents are held back.
- Pending: the field becomes read-only with the new value, and a pending note names the change id;
  a pending mode change shows the chosen mode with its own pending note. Refused: the field keeps the
  rejected value outlined in danger with "Refused: <reason>. The value stays <old>." until edited
  again.
- "Last set" shows who set it ("you", an agent, or "default") and when.

## Component mapping (for the implementation in `console/src/`)

| Design piece (`console-kit.tsx`) | App component (Feature-Sliced Design) |
|---|---|
| `Shell`, rail, tab bar, header | `app/layout/Shell`, `widgets/nav/Rail`, `widgets/nav/TabBar` |
| `FreshChip`, `FreshAlert` | `features/freshness/FreshnessChip`, `features/freshness/FreshnessBanner` |
| `SignIn`, `SignInRefused` | `pages/sign-in` |
| `LineChart` (sparkline mode on tiles) | `shared/ui/LineChart` |
| `Pending`, `Refused` notes | `features/changes/ChangeOutcome` |
| Badges, buttons, segmented control, inputs | `shared/ui/*` |
| Each `<screen>.stories.tsx` page body | `pages/<screen>` |

## Decided here (not deferred)

- Light theme only (see `tokens.html`).
- Undo, Pause/Resume and mode changes post without a confirm dialog: each is reversible from the
  console and appears in the log with its own undo.
- The maintainer's login is shown as `@maintainer` in the renders; the app shows the real login from
  the session.
