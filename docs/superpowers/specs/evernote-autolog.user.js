// ==UserScript==
// @name         Dialer -> Evernote Auto-Log
// @namespace    abdalla-dialer-tools
// @version      1.1
// @description  Auto-writes call outcomes and a position marker into the open Evernote note
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

    if (location.hostname === 'abdalla201-cs.github.io') {
        initDialerSide();
    } else if (location.hostname.endsWith('evernote.com')) {
        initEvernoteSide();
    }

    // ---------- Dialer side ----------

    // Runs inside Tampermonkey's isolated sandbox, so we cannot wrap the
    // page's own functions (assigning window.copyOutcome only touches the
    // sandbox window, not the page's). Instead we observe the shared DOM:
    // listen to outcome-button clicks and watch the current-number display.
    function initDialerSide() {
        waitFor(() => document.getElementById('currentNumberDisplay'), () => {
            // Outcome buttons: capture-phase click listener so we fire even
            // though each button also has its own onclick handler.
            document.querySelectorAll('.btn-outcome').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const number = getCurrentNumber();
                    const outcome = btn.textContent.trim();
                    if (number && outcome) emit({ type: 'outcome', number, outcome });
                }, true);
            });

            // Current number changes (Start / Next / Prev all update this).
            const display = document.getElementById('currentNumberDisplay');
            let lastNumber = '';
            const observer = new MutationObserver(() => {
                const number = getCurrentNumber();
                if (number && number !== lastNumber) {
                    lastNumber = number;
                    emit({ type: 'position', number });
                }
            });
            observer.observe(display, { childList: true, characterData: true, subtree: true });
        });
    }

    function getCurrentNumber() {
        const number = document.getElementById('currentNumberDisplay')?.textContent?.trim();
        return number && number !== '---' ? number : null;
    }

    function emit(event) {
        GM_setValue(EVENT_KEY, JSON.stringify({ ...event, ts: Date.now() }));
    }

    // ---------- Evernote side ----------

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
                handleOutcome(event.number, event.outcome);
            } else if (event.type === 'position') {
                handlePosition(event.number);
            }
        });
    }

    function handleOutcome(number, outcome) {
        const line = findLineWithNumber(number);
        if (!line) {
            showToast(`Number not found in this note: ${number}`);
            return;
        }
        const hasComment = line.el.textContent.trim() !== number;
        const suffix = hasComment ? ` - ${outcome}` : ` ${outcome}`;
        line.el.appendChild(document.createTextNode(suffix));
        notifyEdited(line.el);
    }

    function handlePosition(number) {
        const root = findEditableRoot();
        if (!root) {
            showToast('Evernote editor not found');
            return;
        }
        removeMarker(root);
        const line = findLineWithNumber(number);
        if (!line) {
            showToast(`Number not found in this note: ${number}`);
            return;
        }
        line.el.insertBefore(document.createTextNode(`${MARKER} `), line.el.firstChild);
        notifyEdited(line.el);
    }

    function removeMarker(root) {
        const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const toFix = [];
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.includes(MARKER)) toFix.push(node);
        }
        toFix.forEach((n) => { n.nodeValue = n.nodeValue.replace(`${MARKER} `, '').replace(MARKER, ''); });
    }

    // Assumes each visual line in the Evernote editor is its own block
    // element directly under the contenteditable root. Verify/adjust
    // against the live DOM before relying on this.
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

    function notifyEdited(el) {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }

    function showToast(message) {
        let toast = document.getElementById('dialer-sync-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'dialer-sync-toast';
            toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#ef4444;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:999999;font-family:sans-serif;';
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
