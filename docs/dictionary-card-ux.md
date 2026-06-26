# Dictionary Card — UX spec (per-sample lexicon panel)

Status: **implemented** (`src/dict.ts`, wired in `src/app.ts`, markup in
`index.html`, styles in `src/styles.css`). v2 pipeline is live.
Scope: per-sample / single-session. No cross-corpus, no persistence.

## Surface

Fixed right-docked side panel (~320px, full height, internal scroll) →
bottom-sheet under 600px. Chosen over inline popover (re-anchors on every
keyboard selection move; occludes the centered transcript) and over reusing
the setup/drill bar (wrong role, no room for the occurrences list).

Stacking: panel `z-index: 55` — below `.cam-pip` (60), above `.align-dock`
(50). cam-pip stays user-draggable over it; never repositioned
programmatically.

## Trigger / visibility

- Selection-driven. Reacts to the **existing** `selectedIdx`; does not add a
  click target and does not alter click-to-jump. Updates the same on mouse
  and keyboard selection.
- Visible when `body.drilling` AND `selectedIdx >= 0` AND
  `transcript[selectedIdx].lex != null`.
- Hidden when no selection or token is non-lexical (punctuation) — slides
  out, no empty husk.
- Un-enriched (all ai fields null): still fully functional — shows headword,
  citation IPA, said-here IPA, occurrence count + list. Null sense rows are
  omitted entirely (not empty placeholders); muted `not enriched` footnote.

## Layout (desktop)

```
┌──────────────────────────────────────┐
│ DICTIONARY · this sample          [×] │
├──────────────────────────────────────┤
│  data                          noun   │  lemma (serif) · pos (muted)
│  citation   ˈdeɪtə                    │  lexicon.ipa_citation (--ink)
│  said here  ɾɛɾə            ▲ differs  │  transcript[sel].ipa (--accent)
├──────────────────────────────────────┤
│  dữ liệu                              │  gloss        [omit if null]
│  facts/info processed by a computer    │  definition   [omit if null]
│  dữ liệu máy tính xử lý               │  definition_gloss
│  ⚑ note: …                            │  note         [omit if null]
├──────────────────────────────────────┤
│  SAID 3× IN THIS SAMPLE               │  = len(occurrences)
│  ▸ 1  8.10s  ɾɛɾə      “…the data,…”  │  selected occ (accent left-bar)
│    2  19.4s  deɪɾə     “…raw data…”   │  others: idx·time·own ipa·context
│    3  41.0s  ˈdeɪtə    “…data set…”   │
└──────────────────────────────────────┘  [not enriched]
```

Mobile: bottom-sheet peek bar (grabber · lemma · `cite → said` · count ·
expand caret); tap/caret expands to the same sections full-width.

**Differentiator:** the citation-vs-said-here stack with a text
`differs`/`matches` delta is section 1, never buried — that contrast is the
reason this exists.

## Occurrences interaction

- Each row is focusable + activatable; activating calls existing
  `jumpTo(occ.i, { play: true })` verbatim (reuses the player's only seek
  path). That moves `selectedIdx`, so the card re-renders for that token and
  re-marks the current row — self-consistent, zero conflict.
- Current occurrence marked `.dc-occ-current` (accent inset bar + ▸),
  mirroring the `.w.selected` idiom.
- One new keybinding only: **`Shift+←/→` = prev/next occurrence of the
  current lemma** (wrap), active only while the card is shown. Requires
  gating the existing `←/→` word-nav with `!e.shiftKey`. All other shortcuts
  untouched.

## States / a11y

- 160ms slide-in (match `.align-dock` motion); content swap on selection is
  instant (drill latency).
- `role="complementary"`, `aria-label`, `aria-live="polite"` on content so
  SR announces new headword/IPA on selection change without interrupting.
- Occurrences `role="list"` / `listitem` + inner `<button>`,
  `aria-current="true"` on selected.
- Delta carries text, not color alone (color-blind safe).
- Selection changes never steal focus (body keeps player shortcuts). Focus
  enters panel only via Tab; roving tabindex in list; `×` Tab-reachable.
- Esc unchanged (player deselect → card hides as side effect). Card traps
  nothing.

## Implementation checklist

1. Markup: `<aside id="dict-card" hidden role="complementary">` sibling of
   `#cam-pip`; sub-ids `#dc-lemma #dc-pos #dc-cite #dc-said #dc-delta
   #dc-gloss #dc-def #dc-defgloss #dc-note #dc-occ-count #dc-occ-list
   #dc-close`; mobile `.dc-peek`.
2. CSS in `styles.css` using existing tokens only (--surface, --rule-strong,
   --accent, --faint, --indigo-soft); `.dict-card{position:fixed;right:0;
   top:0;width:320px;height:100vh;z-index:55;…}` `.shown` toggles
   opacity/transform; `@media(max-width:600px)` → bottom sheet + peek.
3. `src/dict.ts`: `selectedIdx → tok=transcript[idx]`; `tok.lex==null` →
   null; else build render model from `lexicon[tok.lex]` (+ occurrences
   mapped through `transcript`, context snippet).
4. Wire `setSelection(idx)` from `jumpTo` and the clear/Esc path; populate,
   omit null sense rows, toggle `.shown`, mark current occurrence row.
5. Occurrence activation → `jumpTo(occ.i,{play:true})`.
6. Keyboard: gate existing `←/→` with `!e.shiftKey`; add `Shift+←/→`
   occurrence nav, active only when shown.
7. a11y wiring (aria-live, roving tabindex, `#dc-close` hides without
   clearing selection).

## Implementation notes

`player.ts` loads v2, adapts `transcript` → internal `Word[]` for the
existing rendering, and exposes `getDictEntry(idx)` / `getOccurrences(idx)`
+ an `onSelect` callback. `src/dict.ts` renders the card from
`getDictEntry`; selection flows player → `onSelect` → `dict.setSelection`.
`ai` fields are still `null` until an external enrichment pass fills them —
the card already degrades gracefully (`not enriched`).
