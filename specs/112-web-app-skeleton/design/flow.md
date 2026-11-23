# Web app skeleton design: frame, flow and interaction notes (spec 112)

The three screens of spec 112 section 7, as Storybook stories in this directory, each rendered at
mobile (390 × 844), tablet (820 × 1180) and desktop (1440 × 900) by spec 029's renderer. The token
set is in `tokens.html`; the frame, the shared pieces and the styles are in `web-kit.tsx`, which
every story imports, so the screens use one token set and one frame. `@panelator/web` does not
exist on `main`, so the stories carry their own markup; "Component mapping" below says what the app
builds from each piece.

This is the product app's first design. It fixes two things later web children inherit: the frame
and the token set. A later child changes either only through its own design.

## Screens and their stories

| Screen | Story | Renders | Address | Document title |
|---|---|---|---|---|
| Home | `home--default` | `home.png`, `home.mobile.png`, `home.tablet.png` | `/` | `panelator` |
| Not found | `not-found--default` | `not-found.png`, `not-found.mobile.png`, `not-found.tablet.png` | any address no route matches | `Page not found · panelator` |
| Error | `error--default` | `error.png`, `error.mobile.png`, `error.tablet.png` | the address of the route that failed (it does not change) | `Something went wrong · panelator` |

The spec names no states for any of the three, so each has its one story. The theme is dark only
(`tokens.html` gives the reason), so there is no second rendering per theme.

## The frame

Every screen is shown inside the frame: a **band** at the top (the `banner` landmark) and the
**main region** below it (the `main` landmark). There is no footer.

- **The band** spans the full width at every viewport: `--color-surface` with a 1px
  `--color-border` lower edge, 56px tall on mobile and 64px from 720px. Its content keeps the page's
  side padding (16, 24, 32px at mobile, tablet, desktop) and is never held to the reading width, so
  the name does not move when a screen switches between reading width and full width.
- **The name** is the band's first item: the dot-matrix "p" mark (decorative, `aria-hidden`) and the
  word `panelator` at 20px bold, together one link to `/` whose accessible name is `panelator`. The
  link is at least 44px tall at every viewport and wider than that by its content. On hover the lit
  dots take `--color-accent-hover`; the word does not change. The mark is a logo: it has no relation
  to any panel's geometry.
- **The band scrolls with the page.** It is not sticky: the editor and the simulator will need the
  height, and these screens are short.
- **The main region** fills the rest of the viewport height (the page is at least one viewport
  tall, so the background never ends early). It has two widths:
  - **reading width**, for text screens such as these three: one column, at most 680px
    (`--size-reading`) plus the side padding, centred in the main region, text left-aligned. Top
    padding 32, 48, 64px and bottom padding 48, 64, 64px at mobile, tablet, desktop. Blocks inside
    it are 32px apart.
  - **full width**, for the editor and the simulator: the main region with no column and no padding
    of its own; the screen that asks for it lays out its own interior. No screen of spec 112 uses
    it; it is the main region without the `ReadingColumn` component.

### Where later children put navigation and the account control

Spec 112 renders neither, because no entry may lead nowhere (AC-7). Their places are fixed now, so
the first child that has a destination adds an entry and moves nothing. `tokens.html` draws both
layouts.

| | Mobile (under 720px) | Tablet and desktop (720px and up) |
|---|---|---|
| Primary navigation (boards, the editor) | A tab bar fixed to the bottom of the viewport, 56px (`--size-tabbar`) plus the device's bottom safe-area inset, `--color-surface` with a 1px `--color-border` upper edge; entries share the width equally, each at least 44px wide, label at 14px. The main region gains bottom padding of the bar's height. | In the band, directly after the name with a 24px gap: a row of links, each 44px tall with 12px side padding and 4px between them, 16px text. |
| Account control | In the band, at its right end: one 44 × 44px control. | In the band, at its right end. |
| The current entry | `--color-accent` text at semibold weight, `--color-accent-soft` fill with `--radius-sm` corners, and `aria-current="page"`; never colour alone. | The same. |

Neither the tab bar nor the navigation row is rendered while it would have no entry; the band then
holds the name alone, as in these renders. When the first primary navigation entry arrives, a
"Skip to content" link arrives with it as the first focusable element of the page. It is left out
now on purpose: with one link in the band there is nothing to skip.

### Breakpoints

| Range | Rendered at | The frame and these screens |
|---|---|---|
| mobile, under 720px | 390 × 844 | band 56px; side padding 16px; heading 28px, lead 16px; buttons stacked, each the full width of the column, 12px apart; Home's list shows each term above its text |
| tablet, 720 to 1199px (`--bp-tablet`) | 820 × 1180 | band 64px; side padding 24px; heading 36px, lead 20px; buttons side by side at their own width, 12px apart; Home's list shows each term (a 144px column) beside its text; main top padding 48px |
| desktop, 1200px and up (`--bp-desktop`) | 1440 × 900 | side padding 32px; main top padding 64px; the reading column stays 680px, centred |

Nothing scrolls sideways at any width from 320px up: the column shrinks with the viewport and every
text wraps.

## Transitions

| From | Action | To |
|---|---|---|
| Any screen | The name in the band | Home at `/`, by the router, without a page load. On Home it is still a link and leads to Home again. |
| Not found | **Go to the home page** | Home at `/`, by the router, without a page load |
| Error | **Reload the page** | the current address, loaded again by the browser (a full page load, `window.location.reload()`); the route is tried afresh, and shows itself if it now works or Error again if it fails again |
| Error | **Go to the home page** | Home at `/`, by the router, without a page load; the error is cleared, so Home shows and not Error again |
| Any address no route matches, loaded directly or reached by navigation | | Not found, inside the frame; the address stays as typed |
| Any route whose component or loader throws | | Error, inside the frame, in place of the route; the address stays |

Home offers no action, so nothing leaves Home but the name in the band.

## Focus and keyboard

- **Focus order** follows the document: the name in the band first, then the controls of the main
  region in reading order.
  - Home: the name. Nothing else is focusable.
  - Not found: the name, then **Go to the home page**.
  - Error: the name, then **Reload the page**, then **Go to the home page**.
- **Visible focus**: every link and button shows a 2px `--color-focus` (white) outline offset 2px on
  `:focus-visible`, with the control's own corner radius (`--radius-sm`). The offset puts the ring
  on the page or band colour, where its contrast is 17:1 or more, whatever the control's fill.
  `tokens.html` draws it on both button looks. No control hides its outline.
- **After a navigation inside the app** (the name, a link home, the browser's back and forward), and
  when Error replaces a route, focus moves to the new screen's `h1`, which carries `tabindex="-1"`,
  so a screen reader announces the new screen and the next Tab goes to its first control. The
  heading shows no ring: it is not a control and was not reached by Tab. The page scrolls to the
  top. On a first load focus is left where the browser puts it.
- **Keys**: links follow on Enter; the reload button acts on Enter and Space. There is no shortcut.
- **Pointer**: hover changes a primary button's fill to `--color-accent-hover` and a secondary
  button's fill to `--color-raised`; the cursor is a pointer over links and buttons. Pressed has no
  look beyond hover. No motion or transition is used, so nothing depends on
  `prefers-reduced-motion`.

## Per-screen notes

**Home**
- An eyebrow ("Open-source LED dashboard"), the `h1` ("An LED dashboard you configure yourself")
  and the lead, then a description list of three parts (The panel, The web app, Open source)
  between 1px dividers, then a note saying the app is under construction and what is not in it yet.
- The copy is the story's, word for word. It describes the product in the words of product spec
  section 1, says plainly that the editor, the simulator and board control are not here yet,
  promises no date and offers no action: no button, and no link other than the name in the band.
- The list is a `dl` with one `dt` and one `dd` per part; the note is a paragraph, not an alert.

**Not found**
- Eyebrow "Error 404", the `h1` "Page not found", one paragraph ("This address leads nowhere. Check
  it for a typo, or start again from the home page."), and one primary button-styled link, **Go to
  the home page**.
- The address that was asked for is not printed: it adds nothing the address bar does not show, and
  a long one would have to be broken to fit a phone.

**Error**
- Eyebrow "Page error" in `--color-danger`, the `h1` "Something went wrong", one paragraph ("This
  page ran into a problem and cannot be shown. Reloading it may fix that."), then **Reload the
  page** (a primary `button`) and **Go to the home page** (a secondary button-styled link), in that
  order: reloading keeps the user where they meant to be, so it comes first.
- No technical detail: no message, no stack, no error code, no "details" disclosure. The error goes
  to the browser console (`console.error`) and nowhere on the page.
- The frame stays: the band and the name work as on any screen.

## Component mapping

`shared/ui` components (each has its own Storybook story in the app, AC-12):

| Component | In `web-kit.tsx` | What it is |
|---|---|---|
| `Frame` | `Frame`, `Mark` | the band with the name as the link home, and the `main` landmark holding its children. The root route in `app` renders it around the matched route. The mark is part of it. |
| `ReadingColumn` | `ReadingColumn` | the main region at reading width: the centred column with its padding and the 32px gap between blocks. A full-width screen leaves it out. |
| `PageHeading` | `PageHeading` | eyebrow, the screen's one `h1` (focusable by script, `tabindex="-1"`) and the lead; tone `neutral` or `danger` colours the eyebrow. |
| `Button` | `Button` | a `button` in the `primary` or `secondary` look, 44px tall. |
| `ButtonLink` | `ButtonLink` | a router link in the same two looks. |

What belongs to a page (`pages/<slice>`):

| Page | Its own parts |
|---|---|
| `home` | its copy; the list of parts (`dl`) and the under-construction note, which no other screen uses |
| `not-found` | its copy; the row holding its one `ButtonLink` |
| `error` | its copy; the row holding the reload `Button` and the `ButtonLink`; writing the error to the console; the reload action |

The row that holds the buttons (stacked on mobile, side by side from 720px, 12px apart) is plain
layout in each of the two pages, not a component.

## Thresholds this design was held to

- Tap targets: the name in the band and every button are at least 44 CSS pixels in both dimensions
  at every viewport, mobile included (`--size-tap`).
- Text: the smallest text is 14px (eyebrows); everything else is 16px or larger.
- Contrast: every text pair on these screens is 7:1 or more against its background, above WCAG AA;
  `tokens.html` lists each pair.
