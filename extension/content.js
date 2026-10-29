// Quiz Helper — content script.
//
// Invisible by design: no panel, no dot, no overlay on screen.
// Answers are delivered as macOS notifications (via the host).
//
// Shortcuts:
//   ⌥A  — answer the question the cursor is inside / currently selected text
//   ⌥Q  — answer every detected question on the page

(() => {
  "use strict";

  const MAX_QUESTIONS = 50;
  const MAX_GROUP_DEPTH = 16;   // deeper DOM trees on real quiz sites
  const IS_TOP = window.top === window;

  // ---------- utils ----------

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  const isVisible = (el) =>
    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  function lca(a, b) {
    const chain = new Set();
    for (let n = a; n; n = n.parentElement) chain.add(n);
    for (let n = b; n; n = n.parentElement) if (chain.has(n)) return n;
    return null;
  }

  function depthFrom(node, root) {
    let d = 0;
    for (let n = node; n && n !== root; n = n.parentElement) d++;
    return d;
  }

  // ---------- question parsing (from raw selected / clicked text) ----------

  function selectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
    return String(sel);
  }

  function parseSelection(raw) {
    const lines = raw.split(/\n+/).map(norm).filter(Boolean);
    const options = [];
    let qEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([A-Ha-h])\s*[).:\-–—]\s*(.+)$/);
      if (m) {
        if (options.length === 0) qEnd = i;
        options.push({ letter: m[1].toUpperCase(), text: m[2].slice(0, 200) });
      } else if (options.length > 0) {
        break;
      }
    }
    if (options.length >= 2) {
      return {
        question: norm(lines.slice(0, qEnd).join(" ")) || options[0].text,
        options,
        multi: /select all|choose all/i.test(raw),
      };
    }
    return { question: norm(raw).slice(0, 500), options: [], multi: false };
  }

  // Figure out which question the user clicked inside, using the clicked
  // element itself (scroll-proof). First try the auto-detector (best
  // structure), then the text block around that element — works on any site.
  function extractAroundClick(hit) {
    const el =
      hit.el && hit.el.isConnected
        ? hit.el
        : document.elementFromPoint(hit.x, hit.y);
    if (!el) return null;
    for (const q of detectQuestions()) {
      if (q.container && (q.container === el || q.container.contains(el))) {
        return { question: q.question, options: q.options, multi: q.multi };
      }
    }
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const t = norm(a.textContent);
      if (t.length >= 25) return parseSelection(t.slice(0, 800));
    }
    return null;
  }

  // ---------- answer request (notification only — no UI) ----------

  async function requestAnswer(parsed, batch) {
    if (!parsed || !parsed.question) return null;
    const payload = {
      type: "answer",
      question: parsed.question,
      options: parsed.options || [],
      multi: !!parsed.multi,
      batch: batch || null,
    };
    // One retry if the message channel breaks (e.g. service worker restart
    // mid-batch) — model-level errors are NOT retried (the host already
    // reported them as a notification).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await chrome.runtime.sendMessage(payload);
        return res || null;
      } catch (e) {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return null;
  }

  // ---------- triggers ----------

  async function answerAllDetected() {
    const questions = detectQuestions();
    if (!questions.length) return;
    const total = questions.length;
    let ok = 0;
    // Sequential: the background queue is serial anyway, and this keeps each
    // request retryable and the notifications ordered.
    for (let i = 0; i < total; i++) {
      const q = questions[i];
      const res = await requestAnswer(
        { question: q.question, options: q.options, multi: q.multi },
        { index: i + 1, total }
      );
      if (res && res.ok) ok++;
    }
    // Completion summary so "still working" is never confused with "failed".
    try {
      await chrome.runtime.sendMessage({
        type: "batchDone",
        total,
        ok,
        failed: total - ok,
      });
    } catch (e) {
      /* best effort */
    }
  }

  async function stealthAnswer() {
    const sel = selectionText();
    let parsed = null;
    if (norm(sel).length >= 12) {
      parsed = parseSelection(sel);
    } else if (lastClick && Date.now() - lastClick.t < 5 * 60 * 1000) {
      parsed = extractAroundClick(lastClick);
    }
    if (!parsed) return;
    await requestAnswer(parsed);
  }

  let lastClick = null;
  document.addEventListener(
    "click",
    (e) => {
      lastClick = { el: e.target, x: e.clientX, y: e.clientY, t: Date.now() };
    },
    true
  );

  // ---------- auto-detect ----------

  // Extract the visible label text for a form input.
  function optionTextForInput(inp) {
    // Explicit <label for="id">
    if (inp.id) {
      const l = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
      if (l && !l.contains(inp)) return norm(l.textContent);
    }
    // Wrapping <label>
    const wrap = inp.closest("label");
    if (wrap) {
      // Strip out any nested input values to get just the label text.
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll("input,select,textarea").forEach((el) => el.remove());
      const t = norm(clone.textContent);
      if (t) return t;
    }
    // aria-label / aria-labelledby
    const al = inp.getAttribute("aria-label");
    if (al) return norm(al);
    const alby = inp.getAttribute("aria-labelledby");
    if (alby) {
      const labelEl = document.getElementById(alby);
      if (labelEl) return norm(labelEl.textContent);
    }
    // Sibling text nodes
    const parent = inp.parentElement;
    if (parent) {
      const direct = norm(
        [...parent.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(" ")
      );
      if (direct) return direct;
      return norm(parent.textContent);
    }
    return norm(inp.value);
  }

  // Extract label text for a custom (non-input) option element.
  function optionTextForCustom(el) {
    const al = el.getAttribute("aria-label");
    if (al) return norm(al);
    const alby = el.getAttribute("aria-labelledby");
    if (alby) {
      const labelEl = document.getElementById(alby);
      if (labelEl) return norm(labelEl.textContent);
    }
    return norm(el.textContent);
  }

  function collectUnits() {
    const units = [];
    const seen = new WeakSet();

    const add = (optEl, text, kind) => {
      if (!optEl || seen.has(optEl)) return;
      const t = norm(text);
      if (!t) return;
      seen.add(optEl);
      units.push({ optEl, text: t, kind });
    };

    // 1. Native radio inputs
    for (const el of document.querySelectorAll('input[type="radio"]')) {
      if (!isVisible(el) || el.disabled) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      add(el.closest("label") || el.parentElement || el, optionTextForInput(el), "radio");
    }

    // 2. ARIA radio roles (custom radio buttons)
    for (const el of document.querySelectorAll('[role="radio"]')) {
      if (!isVisible(el) || el.getAttribute("aria-disabled") === "true") continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      add(el, optionTextForCustom(el), "aria-radio");
    }

    // 3. Native checkboxes
    for (const el of document.querySelectorAll('input[type="checkbox"]')) {
      if (!isVisible(el) || el.disabled) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      add(el.closest("label") || el.parentElement || el, optionTextForInput(el), "checkbox");
    }

    // 4. ARIA checkbox roles
    for (const el of document.querySelectorAll('[role="checkbox"]')) {
      if (!isVisible(el) || el.getAttribute("aria-disabled") === "true") continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      add(el, optionTextForCustom(el), "aria-checkbox");
    }

    // 5. ARIA option roles (used in listbox-style quizzes, e.g. Google Forms)
    for (const el of document.querySelectorAll('[role="option"]')) {
      if (!isVisible(el) || el.getAttribute("aria-disabled") === "true") continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      add(el, optionTextForCustom(el), "aria-option");
    }

    // 6. Generic clickable list items that look like quiz options.
    //    Heuristic: <li> or <div>/<span> whose parent has ≥2 similar siblings
    //    and contains a short text (≤120 chars) with no block children.
    const candidateSelectors = [
      "li[data-value]", "li[data-option]", "li[data-choice]",
      "[data-option-id]", "[data-choice-id]", "[data-answer]",
      ".answer-option", ".option", ".choice", ".quiz-option",
      '[class*="option"]', '[class*="choice"]', '[class*="answer"]',
    ];
    for (const sel of candidateSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;
        if (el.closest('[aria-hidden="true"]')) continue;
        const t = norm(el.textContent);
        if (!t || t.length > 200) continue;
        // Require several siblings matching the same pattern, so a lone
        // "answer"/"option"-classed element on an ordinary page (comments,
        // articles) doesn't become a fake quiz option.
        const sibs = el.parentElement ? el.parentElement.querySelectorAll(sel) : [];
        if (sibs.length < 3) continue;
        add(el, t, "custom");
      }
    }

    // Sort in DOM order.
    units.sort(
      (a, b) =>
        a.optEl.compareDocumentPosition(b.optEl) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    return units;
  }

  // Determine whether two adjacent option elements belong to different questions.
  // Returns true if they should be split into separate groups.
  function shouldSplit(prev, curr) {
    const anc = lca(prev.optEl, curr.optEl);
    if (!anc) return true;

    // If they're both inside named fieldsets that differ → different questions.
    const prevFs = prev.optEl.closest("fieldset,[role=radiogroup],[role=group],[role=listbox]");
    const currFs = curr.optEl.closest("fieldset,[role=radiogroup],[role=group],[role=listbox]");
    if (prevFs && currFs && prevFs !== currFs) return true;

    // If the common ancestor is too far up (very different subtrees).
    if (
      depthFrom(prev.optEl, anc) > MAX_GROUP_DEPTH ||
      depthFrom(curr.optEl, anc) > MAX_GROUP_DEPTH
    ) return true;

    // If there's a heading element between the two options in DOM order,
    // they belong to different questions.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) =>
        /^H[1-6]$/.test(n.tagName) || n.getAttribute?.("role") === "heading"
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP,
    });
    walker.currentNode = prev.optEl;
    const next = walker.nextNode();
    if (next) {
      // Is this heading between prev and curr?
      const afterPrev = next.compareDocumentPosition(prev.optEl) & Node.DOCUMENT_POSITION_PRECEDING;
      const beforeCurr = next.compareDocumentPosition(curr.optEl) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (afterPrev && beforeCurr && norm(next.textContent)) return true;
    }

    return false;
  }

  function groupUnits(units) {
    const groups = [];
    let current = [];
    for (const u of units) {
      if (!current.length) { current = [u]; continue; }
      const prev = current[current.length - 1];
      if (shouldSplit(prev, u) || current.length >= 20) {
        groups.push(current);
        current = [u];
      } else {
        current.push(u);
      }
    }
    if (current.length) groups.push(current);
    return groups.filter((g) => g.length >= 2);
  }

  function findQuestionText(group) {
    const first = group[0].optEl;
    const last  = group[group.length - 1].optEl;
    const container = lca(first, last) || document.body;

    // 1. <legend> inside a fieldset that contains the options.
    const fs = first.closest("fieldset");
    const legend = fs && fs.querySelector("legend");
    if (legend && norm(legend.textContent)) return norm(legend.textContent);

    // 2. aria-labelledby on the group container (radiogroup, listbox, etc.).
    const groupEl = first.closest('[role="radiogroup"],[role="group"],[role="listbox"]');
    if (groupEl) {
      const alby = groupEl.getAttribute("aria-labelledby");
      if (alby) {
        const labelEl = document.getElementById(alby);
        if (labelEl && norm(labelEl.textContent)) return norm(labelEl.textContent);
      }
      const al = groupEl.getAttribute("aria-label");
      if (al) return norm(al);
    }

    // 3. Nearest preceding heading inside the container.
    const heads = [...container.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')];
    for (let i = heads.length - 1; i >= 0; i--) {
      const h = heads[i];
      if (
        norm(h.textContent) &&
        first.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING
      ) return norm(h.textContent).slice(0, 500);
    }

    // 4. Common class-name patterns used by quiz platforms.
    const qEl = container.querySelector(
      '[class*="question-text"],[class*="questionText"],[class*="question_text"],' +
      '[class*="prompt"],[id*="question"],[class*="qtext"],[class*="stem"],' +
      '[class*="question-stem"],[class*="q-text"]'
    );
    if (qEl && norm(qEl.textContent)) return norm(qEl.textContent).slice(0, 500);

    // 5. Nearest preceding heading/legend, climbing a few levels past the
    //    options container (Google-Forms-style keeps the heading outside the
    //    radiogroup).
    let node = first;
    for (let hop = 0; node && hop < MAX_GROUP_DEPTH + 2; hop++, node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (
          /^H[1-6]$/.test(sib.tagName) ||
          sib.tagName === "LEGEND" ||
          sib.getAttribute?.("role") === "heading"
        ) {
          const t = norm(sib.textContent);
          if (t) return t.slice(0, 500);
        }
      }
      if (node === container.parentElement) break;
    }

    // 6. Last resort: strip option texts from each ancestor (innermost
    //    ancestor with concise leftover text wins).
    const optTexts = group.map((u) => u.text).sort((a, b) => b.length - a.length);
    let best = "";
    for (let anc = container; anc && anc !== document.body.parentElement; anc = anc.parentElement) {
      let t = norm(anc.textContent);
      for (const o of optTexts) t = t.split(o).join(" ");
      t = norm(t);
      if (t && t.length >= 9) return t.slice(0, 500);
      if (t && (!best || t.length < best.length)) best = t;
    }
    return best.slice(0, 500);
  }

  function detectQuestions() {
    const units = collectUnits();
    if (!units.length) return [];
    const out = [];
    for (const g of groupUnits(units)) {
      if (out.length >= MAX_QUESTIONS) break;
      const seen = new Set(g.map((u) => u.text.toLowerCase()));
      if (g.length < 2 || seen.size < 2) continue;
      const question = findQuestionText(g);
      if (!question || question.length < 6) continue;
      out.push({
        question: question.slice(0, 600),
        multi: g.every((u) => u.kind === "checkbox" || u.kind === "aria-checkbox"),
        options: g.map((u, i) => ({
          letter: String.fromCharCode(65 + i),
          // drop a leading "A)" prefix if the site letters its options itself
          text:
            u.text.replace(/^[A-Ha-h]\s*[).:\-–—]\s*/, "").slice(0, 200) ||
            u.text.slice(0, 200),
        })),
        container: lca(g[0].optEl, g[g.length - 1].optEl),
      });
    }
    return out;
  }

  // ---------- shortcuts & messages ----------

  let lastShortcut = 0;
  function debounced(fn) {
    const now = Date.now();
    if (now - lastShortcut < 400) return;
    lastShortcut = now;
    fn();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "toggleOverlay") debounced(() => answerAllDetected());
  });

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.code === "KeyQ") {
          e.preventDefault();
          debounced(() => answerAllDetected());
        } else if (e.code === "KeyA") {
          e.preventDefault();
          debounced(() => stealthAnswer());
        }
      }
    },
    true
  );

  // ---------- startup ----------

  // Test hooks only ever fire on local pages (they answer automatically).
  const LOCAL_HOOKS =
    location.protocol === "file:" ||
    /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  function initialScan() {
    // Nothing to show in the UI — detection runs on demand via shortcuts.
    if (!LOCAL_HOOKS) return;
    const h = location.hash;
    if (h === "#qh-auto") setTimeout(() => answerAllDetected(), 600);
    if (h === "#qh-stealth") setTimeout(testStealth, 600);
    if (h === "#qh-select" || h === "#qh-select-mc") setTimeout(testSelect, 600);
  }

  function testStealth() {
    const legend = document.querySelector("legend");
    if (!legend) return;
    lastClick = { el: legend, t: Date.now() };
    stealthAnswer();
  }

  function testSelect() {
    const range = document.createRange();
    if (location.hash === "#qh-select-mc") {
      const fs = document.querySelector("fieldset");
      if (!fs) return;
      range.selectNodeContents(fs);
    } else {
      const legend = document.querySelector("legend");
      if (!legend) return;
      range.selectNodeContents(legend);
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    stealthAnswer();
  }

  if (document.readyState === "complete") initialScan();
  else window.addEventListener("load", initialScan, { once: true });
})();
