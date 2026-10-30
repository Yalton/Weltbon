# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The desktop app (`desktop/`, Electron, offline-first) wraps the same web UI. It is not a separate native design language.

## Users

Fiction writers and game masters, weighted equally. Writers build a world to tell stories in. Game masters build a world to run campaigns in. When their needs conflict, there is no standing tie-breaker; weigh each case on its merits.

Many users are technical enough to self-host with Docker, but self-hosting is a way to run Weltbon, not a requirement for using it.

## Product Purpose

Weltbon is a workspace for building a fictional world: users write entries, link them, and see the world as a graph, timeline and maps. It keeps a large body of lore consistent and navigable as it grows. Success means a world that stays coherent and findable after hundreds of entries, and the user still owns all of it.

## Positioning

Against Obsidian, World Anvil, Campfire and LegendKeeper, Weltbon's claim rests on four things together:

- **You own your data.** It is open source (MPL-2.0) and runs self-hosted or as a desktop app. Markdown goes in and out, with no lock-in.
- **AI lore auditor.** It reads the world and reports contradictions, missing links, timeline inconsistencies, underdeveloped entries and dangling threads.
- **Tools built for worldbuilding.** Typed entries, wikilinks and a link graph, a custom calendar and timeline, maps, diagrams and a conlang dictionary.
- **Sync everywhere.** The desktop app and self-hosted servers sync with a hosted instance. Sync is the only paid tier: the desktop app and self-hosting are free.

## Operating Context

- Mostly long sessions on a desktop or laptop with a keyboard. Phones are for quick reference, not primary work.
- Read-only public share links are a real way readers and players see a world. Share pages must work for outsiders who have never used Weltbon.
- The hosted instance (weltbon.citreum.com) is invite-only for now. Visitors request an invitation; there is no public signup or pricing page yet.
- Self-hosters run Docker Compose with PostgreSQL; the desktop app runs offline.

## Capabilities and Constraints

- Entries are typed (location, event, concept, language and others), with summaries, Markdown bodies, wikilinks, links with types and direction, categories, and timeline pins with precision.
- Views: the entry list and detail, Markdown editor, graph, timeline with a per-universe calendar, maps, diagrams, media, the conlang dictionary, stats, issues from the auditor, and imports (Markdown or Obsidian vaults, DOCX, TXT, JSON).
- Exports: JSON, Markdown and PDF.
- Accounts: invite codes, personal access tokens, admin settings and share tokens.
- AI is optional. Everything works without an AI key. AI features are opt-in, using your own key or a shared hosted budget.
- Terminology: a world is a **universe** and a page is an **entry**. Audit findings are **issues**, in five categories.

## Brand Commitments

- Name: Weltbon.
- Voice: a plain, quiet tool. Copy is short and literal, with no hype. Messages say what happened and what to do next.

## Evidence on Hand

- No testimonials, user counts, customer names or press exist. Never invent them.
- No pricing exists yet. Do not invent prices or plans.
- Real sample content in screenshots and demos is not approved yet; ask before using any real user's world.

## Product Principles

1. **The world is the user's.** Never trap content. Every feature should leave data portable and the app usable offline or self-hosted.
2. **Consistency is the product.** Features earn their place by keeping a growing world coherent and findable.
3. **AI assists, never gates.** No core workflow may depend on an AI key.
4. **Built for long sessions.** Optimise for hours of focused desktop work, and keep phone reading usable.
5. **Quiet and literal.** The interface and its copy stay out of the way of the user's own world.

## Accessibility & Inclusion

Target: WCAG 2.2 AA across the app and public share pages. This covers text and control contrast, full keyboard access with visible focus, screen-reader labels, and no meaning carried by colour or emoji alone.
