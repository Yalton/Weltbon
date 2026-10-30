---
name: Weltbon
description: A working instrument under a night sky, for building and keeping a fictional world.
colors:
  canvas-hi: "#131a2c"
  canvas-mid: "#0b0f1c"
  canvas-lo: "#070a13"
  panel: "#0f1525"
  raised: "#22293b"
  line: "rgb(255 255 255 / 0.08)"
  line-strong: "rgb(255 255 255 / 0.15)"
  ink: "#e8ecf6"
  ink-secondary: "#aeb6cc"
  ink-muted: "#9ba4bb"
  accent: "#8ea2d4"
  accent-strong: "#a9b9e0"
  accent-deep: "#6f84b8"
  accent-ink: "#d5ddf1"
  accent-soft: "rgb(142 162 212 / 0.16)"
  starlight: "#e1e7f5"
  starlight-hover: "#e5eaf6"
  on-starlight: "#0a0e1a"
  link: "#c2ceea"
  danger: "#fda4af"
  type-concept: "#3b82f6"
  type-entity: "#10b981"
  type-location: "#f59e0b"
  type-event: "#f43f5e"
  type-faction: "#a855f7"
  type-artifact: "#f97316"
  type-species: "#14b8a6"
  type-culture: "#ec4899"
  type-thread: "#06b6d4"
  type-unknown: "#6b7280"
typography:
  display:
    fontFamily: "Spectral, Georgia, 'Times New Roman', serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Spectral, Georgia, 'Times New Roman', serif"
    fontSize: "22px"
    fontWeight: 600
    letterSpacing: "-0.005em"
  title:
    fontFamily: "Spectral, Georgia, 'Times New Roman', serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
  wordmark:
    fontFamily: "Spectral, Georgia, 'Times New Roman', serif"
    fontSize: "18px"
    fontWeight: 600
    letterSpacing: "0.01em"
  prose:
    fontFamily: "'Source Sans 3', ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.65
  body:
    fontFamily: "'Source Sans 3', ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
  label:
    fontFamily: "'Source Sans 3', ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.43
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  header: "56px"
  sidebar: "240px"
components:
  button-primary:
    backgroundColor: "{colors.starlight}"
    textColor: "{colors.on-starlight}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.starlight-hover}"
    textColor: "{colors.on-starlight}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-ghost-hover:
    backgroundColor: "rgb(255 255 255 / 0.05)"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  input:
    backgroundColor: "{colors.canvas-lo}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.lg}"
  panel-hover:
    backgroundColor: "{colors.raised}"
  entry-row:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    padding: "12px 16px"
  nav-item:
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  nav-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
  dialog:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.lg}"
    padding: "24px"
  menu:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.md}"
    padding: "4px"
  filter-chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
---

# Design System: Weltbon

## Overview

**Creative North Star: "A Working Instrument Under a Night Sky"**

Weltbon is a quiet tool for long writing sessions. The ground is a flat, deep navy and it stays out of the way of the user's own world. There is one surface system (canvas, panel, raised), solid and edged with 1px hairlines. Starlight, a cool near-white tinted by the universe's accent, fills the single primary control on a screen and colours links. The universe accent itself is reserved for selection, focus and the active nav item.

The only saturated colour at rest is the entry types. Each type has its own hue, like stars of different colour, drawn as a small four-point star (the type star) beside the entry's name. That one mark is meant to carry an entry's type everywhere the entry appears.

Behind it all, an animated constellation drifts across the viewport. It is part of the brand and stays on every route where it appears today: sign-in, the universe list, and every route inside a universe. On the graph it dims to a quarter strength, so it does not read as more graph. Each universe can swap the canvas and accent (observatory, ember, verdant, abyssal, parchment, or a custom accent) and pick a display font. Everything else derives from those two inputs.

**Key Characteristics:**
- Flat deep navy canvas, solid panels, 1px hairlines; no blur, no glow, no decorative gradients.
- One filled starlight button per screen; every other control is outline or text.
- Entry-type hues are the only saturated colour at rest, carried by the four-point type star.
- Spectral for titles and prose headings; Source Sans 3 for UI and reading.
- The animated constellation background is brand and stays; it dims to 25% opacity behind the graph only.
- Per-universe palettes change canvas and accent only; every other token derives from them.

## Colors

A near-monochrome night: navy grounds and cool inks, one accent kept to state, and nine type hues as the only saturated colour.

### Primary
- **Starlight** (`starlight`, observatory value shown): the fill of the one primary button on a screen, with dark ink on it (`on-starlight`), and the caret colour. It is derived as `color-mix(in oklab, var(--color-accent) 16%, #f1f4fb)`, so every palette gets a starlight tinted towards its own accent. Hover lightens it 12% towards white. Fill against its text measures 13.9 to 15.5:1 across all five palettes.
- **Link Starlight** (`link`): link text in prose and small text actions such as "+ New". Derived as `color-mix(in oklab, var(--color-accent) 45%, #eef2fb)`. Links underline at 45% of the link colour, 3px offset, and the underline goes solid on hover.

### Secondary
- **Universe Accent** (`accent`, Observatory Periwinkle by default): focus rings (2px, offset 2px onto the canvas), input focus borders, text selection (40% mix), and the active nav item's soft fill (`accent-soft`, 16 to 18% alpha). Never a button fill, never a text colour for body copy. `deriveAccent()` makes `accent-strong` (30% towards white), `accent-deep` (18% towards black), `accent-ink` (70% towards white) and the ring and soft alphas from any one hex, so a custom accent gets the same family.

### Tertiary
- **Entry-Type Hues** (`type-concept` through `type-thread`, `type-unknown` as fallback): one hue per entry type, drawn as the type star. They are the only saturated colour on a screen at rest. They never fill a button or a surface, and the type is always written next to the star, because colour alone does not carry meaning.

### Neutral
- **Deep Navy Canvas** (`canvas-mid`): the page ground and the focus-ring offset colour. Flat; no vignette.
- **Canvas High / Canvas Low** (`canvas-hi`, `canvas-lo`): the two ends of the palette. `canvas-lo` is the recessed input well; `canvas-hi` is the input to the panel and raised mixes.
- **Panel** (`panel`): sidebar, header chrome, entry list, cards. `color-mix(in oklab, canvas-hi 55%, canvas-mid)`.
- **Raised** (`raised`): dialogs, menus, popovers, inline code, the hover state of interactive panels. `color-mix(in oklab, canvas-hi 92%, #ffffff)`.
- **Hairline / Strong Hairline** (`line`, `line-strong`): 8% and 15% white. `line` divides rows and edges panels; `line-strong` edges controls, inputs and overlays.
- **Ink** (`ink`): titles and body text. 16.2 / 15.4 / 11.8:1 on canvas / panel / raised.
- **Secondary Ink** (`ink-secondary`): summaries, ghost button labels, inactive nav, blockquotes. 9.4 / 9.0 / 6.9:1.
- **Muted Ink** (`ink-muted`): dates, counts, placeholders, separators. 7.7 / 7.3 / 5.8:1 on canvas / panel / raised (observatory); at least 4.9:1 on raised in every palette.
- **Danger Rose** (`danger`): destructive button text and danger menu items, on a transparent ground with a 10 to 15% rose tint on hover. Status colour, not decoration.

### Named Rules
**The Starlight Rule.** One filled starlight control per screen. Everything else is outline (ghost, danger) or text (links). If a screen has two filled buttons, one of them is wrong.

**The Star Colour Rule.** At rest, entry-type hues are the only saturated colour on screen. Accent appears only in response to state (focus, selection, the active nav item); rose and amber appear only for status (errors, warnings, sync conflicts).

**The Two Inputs Rule.** A universe palette sets canvas and accent and nothing else. Every other colour token derives from those, and the derived tokens are re-declared on `:root, [data-theme-scope]` so an inline palette reaches them. Never hard-code a derived colour.

## Typography

**Display Font:** Spectral (with Georgia, Times New Roman, serif)
**Body Font:** Source Sans 3 (with ui-sans-serif, system-ui, sans-serif)

**Character:** A bookish serif for names and headings, set against a plain, legible humanist sans for everything you operate or read at length. The serif names things; the sans does the work.

Each universe may swap the display font for Cormorant Garamond, Cinzel or Crimson Pro (via `--font-display`). Those three are optional per-universe display fonts only, never defaults and never for UI or body text.

### Hierarchy
- **Display** (Spectral 600, 28px, tight leading, -0.025em): the page title, one per page, with actions aligned right on the same line. Prose `h1` also sits at 28px.
- **Headline** (Spectral 600, 22px, -0.005em): prose `h2`. Prose `h3` is 18px; dialog titles are 18px Spectral 600.
- **Title** (Spectral 600, 16px, 1.5): entry names in list rows and links. The universe name in the header is Spectral 400 at 15px; sidebar group headings ("Categories") are Spectral 600 at 14px in secondary ink.
- **Wordmark** (Spectral 600, 18px, +0.01em): "Weltbon" in the header, in ink.
- **Prose** (Source Sans 3 400, 17px, 1.65): entry bodies, paragraphs spaced 0.9em, in the main column of the entry page (at most 1024px, with an 18rem side rail and 32px gap from `lg` up).
- **Body** (Source Sans 3 400, 15px): the document default and nav items.
- **Label** (Source Sans 3 400/600, 14px): buttons (600 on primary), inputs, summaries, dates, menu items. Dates, counts and tables use tabular numerals.

### Named Rules
**The Serif Names Rule.** Spectral sets things that are named: page titles, entry titles, headings, the wordmark, the universe name. Controls, labels and running text are always Source Sans 3.

## Layout

The signed-in shell is a sticky 56px header (wordmark, `/`, universe name in Spectral; shortcuts and user menu at the right) over a 240px sidebar and a scrolling main column. Below `md` (768px) the sidebar becomes a left drawer (max 85vw) opened from a 1.4px-stroke hamburger, over a 72% near-black scrim, rendered inside the theme scope so it keeps the universe palette. The header and main column pad 24px horizontally on desktop and 16px on phones; main pads 32px vertically.

List pages centre in a column of at most 896px. The page header puts the title and its actions on one baseline and wraps the actions under the title when space runs out; there is a 24px gap under it. Entries are rows in a single bordered panel, divided by hairlines, not cards in a grid. A row pads 12px by 16px: medallion, title, type star and type name, summary in secondary ink filling the remaining width, and the date at the right in muted ink. On phones the summary drops to its own line, indented past the medallion, and the date is hidden.

Spacing steps in 4px units; the working set is 4, 8, 12, 16, 24 and 32px. Control groups use 8px gaps; row internals use 12px.

## Elevation & Depth

Flat at rest. Depth comes from tone: canvas, then panel, then raised, each a solid colour with a hairline edge. Nothing on the page casts a shadow and nothing blurs what is behind it. The only shadow is the ambient one under things that genuinely float above the page: dialogs, menus, popovers and the mobile drawer. The `glow` shadow tokens remain in the theme only as `none`.

### Shadow Vocabulary
- **Ambient float** (`box-shadow: 0 16px 40px -12px rgb(0 0 0 / 0.55), 0 2px 6px rgb(0 0 0 / 0.3)`): dialogs, menus, popovers, the nav drawer. Nothing else.

### Named Rules
**The Solid Surface Rule.** Surfaces are opaque and hairline-edged. No backdrop blur, no glass, no glow. If something needs to separate from the page, it moves up a tone (panel to raised), and only a floating overlay also gets the ambient shadow.

**The Constellation Rule.** The animated constellation is brand: it stays on every route where it appears, sits fixed behind everything at `-z-10`, never takes pointer events, pauses when the tab is hidden, and renders a single static frame under reduced motion. Behind the graph it drops to 25% opacity. When a universe has a backdrop image, the image (under a dark vertical scrim for legibility) replaces it.

## Shapes

Gently rounded and plain. Controls, inputs, menu items and nav items use 6px corners; panels, the entry list and dialogs use 8px; callouts and code blocks use 6px; inline code uses 4px. Full circles are kept for things that are round by nature: the entry medallion (36px in rows), the user avatar, count badges and the filter chip. Edges are 1px hairlines; a dashed `line-strong` border marks an empty or additive slot (the "+ Filter" chip, the empty categories box).

The type star is a four-point star with concave sides, drawn from a 10 by 10 viewBox at 10px by default. Line icons are drawn on a 16px grid with a 1.3 to 1.4px round-capped stroke, at 15 to 18px.

## Components

### Buttons
Calm and literal: one bright control, the rest drawn in outline.
- **Shape:** gently rounded (6px), 8px by 14px padding, 14px label, 6px icon gap.
- **Primary:** starlight fill with dark ink, label at 600. One per screen.
- **Hover / Focus:** colour transitions over 150ms. Primary lightens 12% towards white. Focus shows a 2px accent ring offset 2px onto the canvas; mouse focus shows nothing. Disabled drops to 50% opacity with a not-allowed cursor.
- **Ghost:** transparent with a `line-strong` border and secondary ink; on hover a 5% white wash and full ink. Used for every secondary action (Export, Import, Delete's siblings, Cancel).
- **Danger:** transparent with a `line-strong` border and rose text; on hover a 10% rose wash and a rose border. Destructive actions never use a fill.
- Router links that act as buttons use the same `buttonClasses(variant)` helper, so they look identical.

### Chips
- **Filter chip:** a pill with a dashed strong hairline, secondary ink, 4px by 12px; on hover the border darkens to muted ink and the text to full ink.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** panel, edged with a `line` hairline.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Interactive panels:** on hover move up to raised with a `line-strong` edge over 150ms. Rows inside a list instead take a 3% white wash and an inset 2px accent ring on keyboard focus.
- **Callouts:** an 8% accent wash with a 30% accent hairline, 6px corners, 12px by 16px padding. Plain blockquotes use a 2px `line-strong` rule at the left and secondary ink.

### Inputs / Fields
- **Style:** a recessed well: `canvas-lo` fill, `line-strong` border, 6px corners, 8px by 12px, 14px text, muted-ink placeholder.
- **Focus:** the border turns accent and a 2px soft accent ring appears; no outline.

### Navigation
- **Sidebar:** a 240px panel column with a right hairline. Nav items are 15px Source Sans 3 in secondary ink with a 15px line icon at 80% opacity, 6px by 10px, 6px corners. Hover adds a 5% white wash and full ink. The active item gets the soft accent fill, full ink and 600 weight. Below the nav, a hairline, then the categories group under a Spectral heading.
- **Header:** the 56px panel bar described in Layout. Wordmark and universe name are separated by a muted `/`.
- **Mobile:** the sidebar becomes a left drawer with a close button; following a link closes it.

### Dialogs and Menus
- **Dialog:** raised surface, `line-strong` edge, 8px corners, 24px padding, ambient shadow, Spectral 600 18px title, over a 72% near-black scrim. Enters over 180ms (fade, 8px rise, 98% scale) and exits over 140ms.
- **Menu:** raised surface, `line-strong` edge, 6px corners, 4px padding, at least 160px wide, ambient shadow. Items are 14px secondary ink and highlight with a 10% white wash and full ink; danger items are rose. Opens over 120ms with a 4px drop. Separators are a 1px `line`.

### Type Star (signature)
The four-point star in the entry type's hue, with the type name beside it in 14px secondary ink and a 6px gap. It is decorative (`aria-hidden`); the written type carries the meaning. It is the one mark meant to carry type wherever an entry appears; today it is on list rows, entry detail and type badges.

### Entry Medallion
A 36px circle at the start of each row: the entry's cover image if it has one, otherwise the entry's icon or a Spectral 600 monogram in ink on a disc tinted by the type hue with a 1px type-hue ring.

## Do's and Don'ts

### Do:
- **Do** keep exactly one starlight-filled control per screen; make every other action ghost, danger outline or a link.
- **Do** derive every colour from canvas and accent; read `var(--color-*)` tokens and never hard-code a derived value.
- **Do** show an entry's type with the type star and the type name together, in the type's hue.
- **Do** use Spectral 600 for page titles (28px), entry titles and headings, and Source Sans 3 for every control and all running text.
- **Do** keep the animated constellation on every route where it appears today, dimmed to 25% behind the graph, static under reduced motion.
- **Do** separate surfaces by tone and 1px hairlines (canvas, panel, raised); give only floating overlays the ambient shadow.
- **Do** show focus with a 2px accent ring offset onto the canvas, and keep text at WCAG 2.2 AA (4.5:1) on every surface it sits on.
- **Do** list entries as hairline-divided rows in one panel, not as cards.

### Don't:
- **Don't** add a second filled button, or fill a button with the accent or a type hue.
- **Don't** use saturated colour at rest for anything but entry types; accent is for state, rose and amber for status.
- **Don't** use decorative gradients, gradient text, glows on controls or text, backdrop blur or frosted glass. A dark scrim over a user's backdrop or cover image, for legibility, is the only gradient.
- **Don't** use a coloured side stripe as a border accent on cards, rows or alerts.
- **Don't** use Cormorant Garamond, Cinzel or Crimson Pro outside a universe's chosen display font, and never for UI or body text.
- **Don't** remove or hide the constellation background to make a screen "cleaner".
- **Don't** use Tailwind `neutral-*` or light-mode (`bg-white`) classes in new code; use the night-sky tokens.
