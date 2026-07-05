# Evernote Auto-Log Design

## Purpose
The Dialer tool (`index.html`) currently requires manually copying an outcome (e.g. "NIS") and pasting it next to the relevant phone number inside an Evernote note. This is a manual, repetitive step during live cold-calling sessions. Goal: eliminate the copy/paste step and add a visual "current position" marker in Evernote.

## Delivery vehicle
One Tampermonkey userscript, installed once, running with two `@match` rules:
- The Dialer tool's GitHub Pages URL (`https://abdalla201-cs.github.io/Dialer/*`)
- Evernote Web (`https://*.evernote.com/*`)

Cross-tab communication uses Tampermonkey's `GM_setValue` / `GM_addValueChangeListener`, which is shared across domains for a single script — no external server or relay required.

## Behavior

### On the Dialer page
- Hooks `copyOutcome(text)` to also emit an event: `{ type: 'outcome', number: <current formatted number>, outcome: text }`
- Hooks `callCurrentNumber()` (fires on Start/Next/Prev) to emit: `{ type: 'position', number: <current formatted number> }`
- Both events are written via `GM_setValue('dialerEvent', JSON.stringify({...event, ts: Date.now()}))`. The timestamp forces a change even if the same number/outcome repeats.

### On the Evernote page
- Listens via `GM_addValueChangeListener('dialerEvent', ...)`.
- On `outcome` event: finds the line in the currently open note containing the formatted phone number.
  - If the line has trailing text after the number (an existing comment) → append ` - <OUTCOME>` to the end of the line.
  - If the line is just the phone number → append ` <OUTCOME>` directly after it.
- On `position` event: removes the 🟡 marker from wherever it currently is in the note, then inserts 🟡 immediately before the new current number's text.
- If the number isn't found in the currently open note, shows a small on-page toast: "Number not found in this note" instead of failing silently.

## Marker
🟡 (yellow circle emoji), prepended directly before the phone number text. Single instance — moves rather than accumulates.

## Known risk / open item
Evernote's note editor DOM structure (whether the editable area is a plain `contenteditable` in the main document or inside an iframe) has not been inspected live. The implementation will target the common case (contenteditable in main document) and will need one round of live testing/adjustment against the real Evernote DOM to finalize selectors.

## Out of scope
- Does not modify the Dialer tool's existing clipboard-copy behavior (kept as a fallback).
- Does not handle multiple Evernote notes/tabs open simultaneously — targets whichever note is currently focused/open.
- Does not persist marker state across Evernote page reloads (marker is plain text in the note, so it does survive reloads as part of note content; only the *live listener* needs the page to stay loaded to react to further events).
