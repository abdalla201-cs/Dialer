// ==UserScript==
// @name         Dialer -> Evernote Auto-Log
// @namespace    abdalla-dialer-tools
// @version      2.0
// @description  Auto-writes call outcomes and shows a visual position marker in the open Evernote note
// @match        https://abdalla201-cs.github.io/Dialer/*
// @match        https://*.evernote.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const EVENT_KEY = 'dialerEvent';
    const MARKER = '🟡';
    const DEFAULT_COLOR = 'rgb(251, 95, 44)';

    if (location.hostname === 'abdalla201-cs.github.io') {
        initDialerSide();
    } else if (location.hostname.endsWith('evernote.com')) {
        // Only the top frame runs — Evernote loads several same-origin
        // iframes; otherwise the listener fires once per frame (double write).
        if (window.self === window.top) initEvernoteSide();
    }

    // ---------- Dialer side ----------

    function initDialerSide() {
        waitFor(() => document.getElementById('currentNumberDisplay'), () => {
            document.querySelectorAll('.btn-outcome').forEach((btn) => {
                // Single click = copy to clipboard only (the page's own
                // handler also copies; ours guarantees the picked color).
                // Double click = auto-write into Evernote.
                btn.addEventListener('click', () => {
                    const outcome = btn.textContent.trim();
                    if (outcome) copyOutcomeToClipboard(outcome, getDetectedColor());
                }, true);
                btn.addEventListener('dblclick', () => {
                    const number = getCurrentNumber();
                    const outcome = btn.textContent.trim();
                    if (number && outcome) {
                        emit({ type: 'outcome', number, outcome, color: getDetectedColor() });
                    }
                }, true);
            });

            const display = document.getElementById('currentNumberDisplay');
            let lastNumber = '';
            new MutationObserver(() => {
                const number = getCurrentNumber();
                if (number && number !== lastNumber) {
                    lastNumber = number;
                    emit({ type: 'position', number });
                }
            }).observe(display, { childList: true, characterData: true, subtree: true });

            const banner = document.getElementById('activeBanner');
            if (banner) {
                new MutationObserver(() => {
                    if (banner.classList.contains('hidden')) {
                        lastNumber = '';
                        emit({ type: 'stop' });
                    }
                }).observe(banner, { attributes: true, attributeFilter: ['class'] });
            }
        });
    }

    function getCurrentNumber() {
        const number = document.getElementById('currentNumberDisplay')?.textContent?.trim();
        return number && number !== '---' ? number : null;
    }

    function getDetectedColor() {
        const text = document.getElementById('colorHex')?.textContent?.trim();
        return text || DEFAULT_COLOR;
    }

    function emit(event) {
        GM_setValue(EVENT_KEY, JSON.stringify({ ...event, ts: Date.now() }));
    }

    // Also keep the outcome in the clipboard (colored rich text), so it can
    // be pasted manually anywhere even after the auto-write to Evernote.
    function copyOutcomeToClipboard(outcome, color) {
        const html = `<span style="color:${color};--inversion-type-color:simple;">${outcome}</span>`;
        try {
            const item = new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([outcome], { type: 'text/plain' })
            });
            navigator.clipboard.write([item]).catch(() => {
                navigator.clipboard.writeText(outcome).catch(() => {});
            });
        } catch (e) {
            navigator.clipboard.writeText(outcome).catch(() => {});
        }
    }

    // ---------- Evernote side ----------

    let markerEl = null;
    let currentMarkerNumber = null;

    function initEvernoteSide() {
        GM_addValueChangeListener(EVENT_KEY, (key, oldValue, newValue, remote) => {
            if (!remote || !newValue) return;
            let event;
            try {
                event = JSON.parse(newValue);
            } catch (e) {
                return;
            }
            if (event.type === 'outcome') {
                handleOutcome(event.number, event.outcome, event.color);
            } else if (event.type === 'position') {
                handlePosition(event.number);
            } else if (event.type === 'stop') {
                hideMarker();
            }
        });

    }

    function handleOutcome(number, outcome, color) {
        const line = findLineWithNumber(number);
        if (!line) {
            showToast(`Number not found in this note: ${number}`);
            return;
        }
        const hasComment = stripMarker(line.el.textContent).trim() !== number;
        const text = (hasComment ? ' - ' : ' ') + outcome;
        const chosen = color || DEFAULT_COLOR;
        const html = `<span style="color:${chosen};--inversion-type-color:simple;">${escapeHtml(text)}</span>`;
        const doc = line.el.ownerDocument;
        const editable = findEditableRoot();
        if (editable && editable.focus) editable.focus();

        // Put the DOM caret at the end of the target line.
        const range = doc.createRange();
        range.selectNodeContents(line.el);
        range.collapse(false);
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        // Evernote's editor syncs its internal caret from the DOM selection
        // asynchronously (on selectionchange). Pasting immediately lands at
        // the OLD caret (wherever the user last clicked). Wait a beat so the
        // editor picks up the new selection, re-assert it, then paste.
        setTimeout(() => {
            sel.removeAllRanges();
            sel.addRange(range);

            let pasted = false;
            try {
                const dt = new DataTransfer();
                dt.setData('text/html', html);
                dt.setData('text/plain', text);
                const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
                // dispatchEvent returns false if the editor called
                // preventDefault, i.e. it handled the paste itself.
                pasted = editable.dispatchEvent(evt) === false;
            } catch (e) { /* ClipboardEvent may be unsupported */ }

            if (!pasted) {
                // Fallback: insert plain text then color it via the editor command.
                doc.execCommand('insertText', false, text);
                const fNode = sel.focusNode;
                const fOff = sel.focusOffset;
                if (fNode && fNode.nodeType === 3 && fOff >= text.length) {
                    const colorRange = doc.createRange();
                    colorRange.setStart(fNode, fOff - text.length);
                    colorRange.setEnd(fNode, fOff);
                    sel.removeAllRanges();
                    sel.addRange(colorRange);
                    try { doc.execCommand('styleWithCSS', false, true); } catch (e) {}
                    doc.execCommand('foreColor', false, chosen);
                    sel.collapseToEnd();
                }
            }
        }, 150);
    }

    // Floating overlay marker — never inserted into the note, so it is not
    // saved as text. Lives in the same document as the editor (iframe-safe).
    function handlePosition(number) {
        cleanupTextMarkers();
        currentMarkerNumber = number;
        const rect = getNumberRect(number);
        if (!rect) {
            showToast(`Number not found in this note: ${number}`);
            hideMarker();
            return;
        }
        showMarkerAt(rect);
        startMarkerTracking();
    }

    // Continuously track the number's on-screen position (every frame).
    // Evernote scrolls/re-renders its note in ways that fire no window
    // scroll/resize events, so event-based repositioning goes stale.
    let trackingActive = false;
    function startMarkerTracking() {
        if (trackingActive) return;
        trackingActive = true;
        const tick = () => {
            if (!currentMarkerNumber) { trackingActive = false; return; }
            const rect = getNumberRect(currentMarkerNumber);
            if (rect && rect.width) {
                showMarkerAt(rect);
            } else if (markerEl) {
                markerEl.style.display = 'none'; // number scrolled out / not found
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    function ensureMarkerEl() {
        const editable = findEditableRoot();
        const doc = editable ? editable.ownerDocument : document;
        // Recreate if missing or if it lives in the wrong document.
        if (markerEl && markerEl.ownerDocument === doc) return markerEl;
        if (markerEl && markerEl.parentNode) markerEl.parentNode.removeChild(markerEl);
        markerEl = doc.createElement('div');
        markerEl.textContent = MARKER;
        markerEl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font-size:16px;line-height:1;';
        doc.body.appendChild(markerEl);
        return markerEl;
    }

    function showMarkerAt(rect) {
        const el = ensureMarkerEl();
        el.style.display = 'block';
        el.style.left = (rect.left - 22) + 'px';
        el.style.top = (rect.top + rect.height / 2 - 8) + 'px';
    }

    function hideMarker() {
        currentMarkerNumber = null;
        if (markerEl) markerEl.style.display = 'none';
    }

    function getNumberRect(number) {
        const line = findLineWithNumber(number);
        if (!line) return null;
        const doc = line.el.ownerDocument;
        const range = doc.createRange();
        range.selectNode(line.textNode);
        const rect = range.getBoundingClientRect();
        return rect && rect.width ? rect : line.el.getBoundingClientRect();
    }

    // Remove any 🟡 saved into note text by older script versions.
    function cleanupTextMarkers() {
        const root = findEditableRoot();
        if (!root) return;
        const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const hits = [];
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.includes(MARKER)) hits.push(node);
        }
        hits.forEach((n) => { n.nodeValue = stripMarker(n.nodeValue); });
    }

    function stripMarker(text) {
        return text.split(`${MARKER} `).join('').split(MARKER).join('');
    }

    function findLineWithNumber(number) {
        const root = findEditableRoot();
        if (!root) return null;
        const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.includes(number)) {
                let el = node.parentElement;
                while (el && el.parentElement !== root) el = el.parentElement;
                if (el) return { el, textNode: node };
            }
        }
        return null;
    }

    function findEditableRoot() {
        const direct = document.querySelector('[contenteditable="true"]');
        if (direct) return direct;
        for (const frame of document.querySelectorAll('iframe')) {
            try {
                const found = frame.contentDocument?.querySelector('[contenteditable="true"]');
                if (found) return found;
            } catch (e) {
                // cross-origin iframe, skip
            }
        }
        return null;
    }

    function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function notifyEdited(el) {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }

    function showToast(message) {
        let toast = document.getElementById('dialer-sync-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'dialer-sync-toast';
            toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#ef4444;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:2147483647;font-family:sans-serif;';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.style.display = 'block';
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
    }

    function waitFor(condition, callback, attempts = 20) {
        if (condition()) { callback(); return; }
        if (attempts <= 0) return;
        setTimeout(() => waitFor(condition, callback, attempts - 1), 250);
    }
})();
