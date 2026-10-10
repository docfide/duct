# Accessibility

Duct aims to meet WCAG 2.2 at level AA. The conformance report (VPAT® 2.5, WCAG edition) is published at
https://duct.tensflare.com/legal/accessibility/ and must stay true: when a change affects a criterion, update it
(`duct-site/src/accessibility.mjs`).

## Automated

`npm run build && npm run a11y` (`scripts/a11y-electron.cjs`) starts Duct with a small sample library, opens every main
screen in Chromium (Electron) and runs axe-core with the WCAG 2.2 A and AA rules. Any violation fails it, and CI runs it
on macOS for every pull request. Add a screen to the list in that script when you add one to the app.

## By hand, before a release

axe-core can't judge these, so check them when the related screens change:

- **Keyboard only:** search, open a result, step through matches (Enter, Shift+Enter), switch layouts, close a pane,
  and add a quote: Tab to the document, ↑ ↓ to select a paragraph, Enter. ⌘⇧N / Ctrl+Shift+N adds any selection,
  ⌘⇧M / Ctrl+Shift+M opens the notebook menu.
- **Focus** is always visible, and dialogs give focus back when they close.
- **Reflow:** at 400% zoom in a 1280-pixel window (320 CSS pixels), nothing scrolls sideways except wide tables.
- **Text spacing:** with line height 1.5, letter spacing 0.12em, word spacing 0.16em and paragraph spacing 2em,
  nothing is clipped.
- **Contrast:** new colours meet 4.5:1 for text and 3:1 for field borders on every panel they sit on
  (`--muted` and `--field-border` in `assets/ui/app.css` are the floors).
- **Motion:** animations stop within 5 seconds and don't play with reduced motion.
- **Status messages** use a live region (`role="status"`).

## Known gaps

- Selecting part of a paragraph needs a pointer or a screen reader's own selection (WCAG 2.1.1, partially supported).
- Resizing two documents to an exact size without dragging needs the arrow keys (2.5.7, partially supported).
- Not yet tested with people who use screen readers every day; planned before 1.0.
