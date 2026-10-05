# Cognilix design system (Echo and Clarix)

Neo-minimal base, micro-maximal details. Both products load the same token file, so a colour, size or state means
the same thing in each. This page is for developers changing the UI.

## Files

| What | Echo | Clarix |
| :--- | :--- | :--- |
| Shared tokens (keep identical) | `src/ds-tokens.css` | `src/styles/ds-tokens.css` |
| Product layer and accent | `src/styles.css` (top: accent; end: neo-minimal layer) | `src/styles/theme.scss` (accent), `src/styles.scss` (Tailwind bridge, neo-minimal layer) |
| Component recipes | classes in `src/styles.css` (`.btn`, `.card`, `.tag`, `.input`, `.ck`) | mixins in `src/styles/_ds.scss` (`ds.btn`, `ds.card`, `ds.badge`, `ds.input`, `ds.micro-label`, `ds.big-number`, `ds.table-card`) |
| Theme switch | `data-theme="light|dark"` on `<html>` (side bar foot) | `.dark` class on `<html>` (side bar foot) |

Never write a hex colour in a component. Use a token. Charts that need real colours use the chart palette below.

## Colour

| Role | Light | Dark |
| :--- | :--- | :--- |
| Page | `#FFFFFF` white | `#000000` black |
| Cards, panels | `#FFFFFF` with a `#E7E5E2` hairline | `#0C0B0A` with a `#282624` hairline |
| Wells, table heads, empty states | `#F0EEE9` PANTONE 11-4201 Cloud Dancer | `#0C0B0A` |
| Side bar | `#F7F6F3` | `#0A0908` |
| Text | `#0C0A09` | `#F0EEE9` (Cloud Dancer) |
| Secondary, muted, placeholder | `#44403C`, `#5C5752`, `#69635D` | `#D6D3CF`, `#A8A29E`, `#8F8983` |
| Echo accent | `#DA291C` PANTONE 485 C | `#DA291C` (text on black: `#FF8B80`) |
| Clarix accent | `#4C4184` PANTONE 7672 C | `#6A5FC1` (text on black: `#BCB5F5`) |

- Buttons on the accent always use white text.
- Greys are warm stone, so they sit with Cloud Dancer.
- Status colours (`--ds-success|warning|danger|info|neutral` with `-fg`, `-bg`, `-border`) carry meaning only. Text uses the `-fg` tone; dots and bars use the solid tone.
- Chart palette (works on white and black): success `#16A34A`, accent `#6A5FC1` or `#DA291C`, warning `#E28A0B`, danger `#DC2626`, neutral `#A8A29E`.
- Contrast is checked on every page in both themes: text 4.5:1 or more, borders and controls 3:1 or more.

## Type

- Geist for everything; Geist Mono for micro labels, ids, keys and code.
- Sizes: 11, 12, 13 (body), 14, 16, 20, 24, 26 (page title) px. Page titles 650 weight, tight tracking.
- Micro label (the only place for caps): mono, 11 px, 0.07em tracking, muted. Card titles, column heads, stat labels, nav groups.
- Numbers are tabular everywhere (tables, counters, durations). Overview numbers are big (30 px, 650).

## Shape and depth

- Radius 4, 6, 8 (controls), 10 (cards), 14 (modals).
- Cards are flat: hairline border, no shadow. A card that is a link lifts 1 px and gains a soft shadow on hover.
- Shadows are for things that float: menus, popovers, modals, toasts.

## Components

- **Button:** 36 px (30 px small). Primary uses the accent with a hairline top highlight; secondary is white or black with a stone edge; ghost has no edge. Pressing shrinks it slightly. Disabled stays readable.
- **Status badge:** a solid dot, then the word, on a soft tint. Never colour alone. Running states pulse the dot.
- **Input:** white or black field with a stone edge; hover darkens the edge; focus is the accent edge with a soft ring.
- **Table:** Cloud Dancer head with micro labels, hairline rows, quiet hover.
- **Tabs:** text tabs with an ink underline on the active one; segmented controls for views.
- **Modal:** lifts and fades in over a blurred backdrop; Esc and the backdrop close it.
- **Info icon:** opens on hover after a short pause or on focus; closes on leave, Esc, scroll or a click outside; tap pins it on touch.
- **Empty state:** a Cloud Dancer well with a dashed edge, a title, one line and one action.
- **Side bar:** icons when closed, opens on hover, pin handle in the middle. Active page is a white (or black) chip with a hairline and a 3 px accent bar.
- **Agent ready to run checklist (Echo):** one compact line of tick boxes with a count and a small progress bar. A missing item has an amber box; clicking it opens the tab that fixes it. When everything is ticked it reads "Ready to run" in green.

## Interaction rules

- **Dialogs:** use `role="dialog"` (Clarix) or `.modal` (Echo). The shared helper `src/app/core/a11y/dialog-keys.ts` (installed once in the shell or layout) moves focus in on open, keeps Tab inside, closes on Esc (the dialog's Close or Cancel button, else its backdrop) and returns focus to the opener. Centre dialogs with flex or grid; if you centre with a transform, do not animate the transform.
- **Tabs:** `role="tablist"` with `role="tab"` buttons, `aria-selected`, roving `tabindex` and arrow, Home and End keys. Counts go in a small mono chip.
- **Navigation:** the active side bar link carries `aria-current="page"`. Clarix has no page header: each page shows its own title; phones get a slim bar with the menu button.
- **Targets:** every control is at least 24 x 24 px (enlarge with padding and a matching negative margin so the layout does not move).
- **Fields:** every input, select and textarea has a visible label or an `aria-label`.
- **Truncation:** text cut with an ellipsis carries the full text in `title`.
- **Theme:** `index.html` sets the saved or system theme before the app loads, so there is no flash and the sign in page follows the theme.

## Motion

- Fast and physical: 80 to 220 ms. Press feedback on buttons, a spring on switches and tick boxes, a lift for modals and menus.
- Nothing moves on its own except live states (a pulsing dot for something running).
- `prefers-reduced-motion` turns animation off everywhere.

## Checks before you merge

1. No hex colours in components (charts excepted).
2. Light and dark at 375, 768 and 1440 px: no clipped text, no sideways page scroll.
3. Contrast: paste `docs/ui-audit.js` into the browser console on every page you touched, in both themes.
4. Keyboard: every action reachable, a visible focus ring, Esc closes popovers and modals.
