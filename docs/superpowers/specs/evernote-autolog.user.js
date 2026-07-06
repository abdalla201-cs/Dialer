// ==UserScript==
// @name         Dialer -> Evernote Auto-Log
// @namespace    abdalla-dialer-tools
// @version      1.4
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
                btn.addEventListener('click', () => {
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

        window.addEventListener('scroll', repositionMarker, true);
        window.addEventListener('resize', repositionMarker, true);
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
        const doc = line.el.ownerDocument;
        const editable = findEditableRoot();
        if (editable && editable.focus) editable.focus();

        // Caret at end of the line.
        const range = doc.createRange();
        range.selectNodeContents(line.el);
        range.collapse(false);
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        // 1) Insert the outcome as plain text through the editor.
        doc.execCommand('insertText', false, text);

        // 2) Select exactly that text and apply the color with the editor's
        //    own color command — Evernote strips raw inline-style spans, but
        //    honors foreColor (the same path used when you color manually).
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

    function repositionMarker() {
        if (!currentMarkerNumber || !markerEl || markerEl.style.display === 'none') return;
        const rect = getNumberRect(currentMarkerNumber);
        if (rect) showMarkerAt(rect);
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
