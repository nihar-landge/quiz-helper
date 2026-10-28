// Quiz Helper — content script.
//
// Discreet by design: nothing ever appears next to the question.
//   • Click inside a question (single click, no dragging), press ⌥A.
//   • Or select text and click the tiny dot near it (or just press ⌥A).
//   • Or press ⌥Q to answer every detected question on the page.
// All answers show up as small numbered rows in a corner panel, and can
// optionally be spoken aloud (see the popup's "Speak answers" toggle).
// Show-only: it never clicks anything for you.

(() => {
  "use strict";

  const MAX_QUESTIONS = 25;
  const MAX_GROUP_DEPTH = 8;
  const IS_TOP = window.top === window;

  // ---------- utils ----------

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  const isVisible = (el) =>
    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

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

  function boundaryBetween(a, b) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) =>
        /^H[1-6]$/.test(n.tagName) ||
        n.tagName === "LEGEND" ||
        n.getAttribute?.("role") === "heading"
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP,
    });
    walker.currentNode = a;
    let steps = 0;
    let n = walker.nextNode();
    while (n && steps++ < 400) {
      if (n === b || n.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING)
        return null;
      if (norm(n.textContent)) return n;
      n = walker.nextNode();
    }
    return null;
  }

  // ---------- question parsing ----------

  function selectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
    return String(sel);
  }

  // Raw text → {question, options, multi}. Option lines look like "A) text".
  function parseSelection(raw) {
    const lines = raw
      .split(/\n+/)
      .map(norm)
      .filter(Boolean);
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

  // Figure out which question the user clicked inside. First try the
  // auto-detector (best structure), then fall back to the text block around
  // the click — which works on any site.
  function extractAroundClick(x, y) {
    for (const q of detectQuestions()) {
      const r = q.container.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return { question: q.question, options: q.options, multi: q.multi };
      }
    }
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && i < 7; i++, el = el.parentElement) {
      const t = norm(el.textContent);
      if (t.length >= 25) return parseSelection(t.slice(0, 600));
    }
    return null;
  }

  // ---------- corner panel ----------

  let hostEl = null;
  let shadow = null;
  let rowsEl = null;
  let panelEl = null;
  let open = false;
  let rowSeq = 0;

  function ensureUI() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.style.cssText =
      "position:fixed;top:18px;right:18px;z-index:2147483647;all:initial;";
    shadow = hostEl.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }
      .dot { width: 12px; height: 12px; border-radius: 50%;
        background: rgba(130,130,130,0.35); cursor: pointer; transition: background .15s; }
      .dot:hover { background: rgba(130,130,130,0.75); }
      .panel { position: fixed; top: 18px; right: 18px; width: 240px; max-height: 55vh;
        overflow-y: auto; background: rgba(28,28,30,0.92); color: #d8d8d8;
        border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 8px 10px;
        font-size: 12px; line-height: 1.5; backdrop-filter: blur(8px); }
      .panel .hd { display: flex; justify-content: space-between; align-items: center;
        color: #777; font-size: 10px; letter-spacing: .06em; padding: 0 2px 4px; }
      .panel .hd span.x { cursor: pointer; padding: 0 4px; }
      .panel .hd span.x:hover { color: #ccc; }
      .row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 1px 2px; }
      .row b { color: #eee; font-weight: 600; }
      .row .a { color: #9a9a9a; }
      .row.wait { opacity: .45; }
      .row.err { color: #b07070; white-space: normal; }
    `;
    shadow.appendChild(style);

    const dot = document.createElement("div");
    dot.className = "dot";
    dot.addEventListener("click", () => togglePanel());
    shadow.appendChild(dot);

    panelEl = document.createElement("div");
    panelEl.className = "panel";
    panelEl.style.display = "none";
    const hd = document.createElement("div");
    hd.className = "hd";
    hd.innerHTML = '<span>answers</span><span class="x" title="close">✕</span>';
    hd.querySelector(".x").addEventListener("click", () => togglePanel(false));
    panelEl.appendChild(hd);
    rowsEl = document.createElement("div");
    panelEl.appendChild(rowsEl);
    shadow.appendChild(panelEl);

    document.documentElement.appendChild(hostEl);
  }

  function togglePanel(force) {
    open = force !== undefined ? force : !open;
    ensureUI();
    panelEl.style.display = open ? "" : "none";
  }

  function addRow(hint) {
    ensureUI();
    if (!open) togglePanel(true);
    rowSeq++;
    const row = document.createElement("div");
    row.className = "row wait";
    row.dataset.n = rowSeq;
    row.textContent = `${rowSeq} · …${hint ? " " + hint : ""}`;
    rowsEl.appendChild(row);
    while (rowsEl.children.length > 30) rowsEl.removeChild(rowsEl.firstChild);
    panelEl.scrollTop = panelEl.scrollHeight;
    return rowSeq;
  }

  function setRow(n, cls, html, title) {
    const row = [...rowsEl.children].find((r) => r.dataset.n === String(n));
    if (!row) return;
    row.className = "row " + cls;
    row.innerHTML = html;
    if (title) row.title = title;
  }

  async function requestAnswer(parsed) {
    if (!parsed || !parsed.question) return;
    const n = addRow();
    try {
      const res = await chrome.runtime.sendMessage({
        type: "answer",
        question: parsed.question,
        options: parsed.options || [],
        multi: !!parsed.multi,
      });
      if (res?.ok) {
        const reason = (res.oneLineReason || "").replace(/"/g, "&quot;");
        const letters = (String(res.optionLetter || "").match(/[A-Za-z]/g) || [])
          .join(",")
          .toUpperCase();
        if (letters) {
          setRow(
            n,
            "",
            `${n} · <b>${escapeHtml(letters)}</b> · <span class="a">${escapeHtml(
              (res.answerText || "").slice(0, 46)
            )}</span>`,
            reason
          );
        } else {
          setRow(
            n,
            "",
            `${n} · <span class="a">${escapeHtml((res.answerText || "").slice(0, 60))}</span>`,
            reason
          );
        }
      } else {
        setRow(n, "err", `${n} · ${escapeHtml(res?.error || "failed")}`);
      }
    } catch (e) {
      setRow(n, "err", `${n} · ${escapeHtml(String(e.message || e))}`);
    }
  }

  // ---------- triggers ----------

  // ⌥Q: answer every question the detector finds.
  async function answerAllDetected() {
    const questions = detectQuestions();
    if (!questions.length) {
      const n = addRow();
      setRow(n, "err", `${n} · nothing detected — click inside a question and press ⌥A`);
      setTimeout(() => {
        const row = [...rowsEl.children].find((r) => r.dataset.n === String(n));
        if (row && row.classList.contains("err")) row.remove();
      }, 4000);
      return;
    }
    for (const q of questions) {
      await requestAnswer({ question: q.question, options: q.options, multi: q.multi });
    }
  }

  // ⌥A: answer what was just clicked (or the current selection).
  async function stealthAnswer() {
    const sel = selectionText();
    let parsed = null;
    if (norm(sel).length >= 12) {
      parsed = parseSelection(sel);
    } else if (lastClick && Date.now() - lastClick.t < 5 * 60 * 1000) {
      parsed = extractAroundClick(lastClick.x, lastClick.y);
    }
    if (!parsed) {
      const n = addRow();
      setRow(n, "err", `${n} · click inside a question first, then ⌥A`);
      setTimeout(() => {
        const row = [...rowsEl.children].find((r) => r.dataset.n === String(n));
        if (row && row.classList.contains("err")) row.remove();
      }, 4000);
      return;
    }
    await requestAnswer(parsed);
  }

  // remember where the user last clicked (a single click — no selection drag)
  let lastClick = null;
  document.addEventListener(
    "click",
    (e) => {
      if (hostEl && e.composedPath().includes(hostEl)) return;
      if (selHost && e.composedPath().includes(selHost)) return;
      lastClick = { x: e.clientX, y: e.clientY, t: Date.now() };
    },
    true
  );

  // ---------- auto-detect (used by ⌥Q and the click locator) ----------

  function optionTextForInput(inp) {
    if (inp.id) {
      const l = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
      if (l && !l.contains(inp)) return norm(l.textContent);
    }
    const wrap = inp.closest("label");
    if (wrap) {
      const cloneOnly = norm(wrap.textContent);
      if (cloneOnly) return cloneOnly;
    }
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
    return norm(inp.getAttribute("aria-label") || inp.value);
  }

  function collectUnits() {
    const units = [];
    const radios = [
      ...document.querySelectorAll('input[type="radio"], [role="radio"]'),
    ].filter(isVisible);

    for (const el of radios) {
      if (el.closest && el.closest('[aria-hidden="true"]')) continue;
      if (el.disabled) continue;
      let text, optEl;
      if (el.tagName === "INPUT") {
        text = optionTextForInput(el);
        optEl = el.closest("label") || el.parentElement || el;
      } else {
        text = norm(el.getAttribute("aria-label") || el.textContent);
        optEl = el;
      }
      if (text) units.push({ optEl, text, kind: el.tagName === "INPUT" ? "input" : "aria" });
    }

    const boxes = [...document.querySelectorAll('input[type="checkbox"]')].filter(
      (el) => isVisible(el) && !el.disabled
    );
    const boxUnits = boxes.map((el) => ({
      optEl: el.closest("label") || el.parentElement || el,
      text: optionTextForInput(el),
      kind: "checkbox",
    }));
    const usableBoxes = boxUnits.filter((u) => u.text);
    if (usableBoxes.length >= 3) units.push(...usableBoxes);

    units.sort(
      (a, b) =>
        (a.optEl.compareDocumentPosition(b.optEl) & Node.DOCUMENT_POSITION_FOLLOWING)
          ? -1
          : 1
    );
    return units;
  }

  function groupUnits(units) {
    const groups = [];
    let current = [];
    for (const u of units) {
      if (!current.length) {
        current = [u];
        continue;
      }
      const prev = current[current.length - 1];
      const anc = lca(prev.optEl, u.optEl);
      const tooFar =
        !anc ||
        depthFrom(prev.optEl, anc) > MAX_GROUP_DEPTH ||
        depthFrom(u.optEl, anc) > MAX_GROUP_DEPTH;
      const prevBox = prev.optEl.closest("fieldset, [role=radiogroup]");
      const thisBox = u.optEl.closest("fieldset, [role=radiogroup]");
      const differentBox = prevBox && thisBox && prevBox !== thisBox;
      const split = tooFar || differentBox || boundaryBetween(prev.optEl, u.optEl);
      if (split || current.length >= 14) {
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
    const container = lca(first, group[group.length - 1].optEl) || document.body;

    const fs = first.closest("fieldset");
    const legend = fs && fs.querySelector("legend");
    if (legend && norm(legend.textContent)) return norm(legend.textContent);

    const heads = container.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]');
    for (const h of heads) {
      if (
        norm(h.textContent) &&
        first.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING
      )
        return norm(h.textContent);
    }

    const qEl = container.querySelector(
      '[class*="question"],[class*="prompt"],[id*="question"],[class*="qtext"]'
    );
    if (qEl && norm(qEl.textContent)) return norm(qEl.textContent);

    let node = first;
    for (let hop = 0; hop < MAX_GROUP_DEPTH && node && node !== container; hop++) {
      let sib = node.previousElementSibling;
      for (let i = 0; i < 3 && sib; i++) {
        const t = norm(sib.textContent);
        if (t.length >= 12) return t.slice(0, 400);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }

    const optTexts = group.map((u) => u.text).sort((a, b) => b.length - a.length);
    let best = "";
    for (
      let anc = first.parentElement;
      anc && anc !== container.parentElement;
      anc = anc.parentElement
    ) {
      let t = norm(anc.textContent);
      for (const o of optTexts) t = t.split(o).join(" ");
      t = norm(t);
      if (t && (!best || t.length < best.length)) best = t;
      if (best.length > 8) break;
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
      if (!question || question.length < 8) continue;
      out.push({
        question: question.slice(0, 500),
        multi: g.every((u) => u.kind === "checkbox"),
        options: g.map((u, i) => ({
          letter: String.fromCharCode(65 + i),
          text: u.text.slice(0, 200),
        })),
        anchor: g[0].optEl,
        container: lca(g[0].optEl, g[g.length - 1].optEl),
      });
    }
    return out;
  }

  // ---------- selection bubble (optional trigger) ----------

  let selHost = null;
  let selShadow = null;
  let selBubble = null;

  function ensureSelUI() {
    if (selHost) return;
    selHost = document.createElement("div");
    selHost.style.cssText = "position:fixed;z-index:2147483647;all:initial;";
    selShadow = selHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, system-ui, sans-serif; }
      .bubble {
        position: fixed; width: 13px; height: 13px; border-radius: 50%;
        background: rgba(130,130,130,0.4); cursor: pointer; transition: background .15s;
      }
      .bubble:hover { background: rgba(130,130,130,0.85); }
    `;
    selShadow.appendChild(style);
    selBubble = document.createElement("div");
    selBubble.className = "bubble";
    selBubble.style.display = "none";
    selBubble.title = "answer → corner panel";
    selBubble.addEventListener("click", (e) => {
      e.stopPropagation();
      const text = selectionText();
      if (norm(text).length >= 12) requestAnswer(parseSelection(text));
      selBubble.style.display = "none";
    });
    selShadow.appendChild(selBubble);
    document.documentElement.appendChild(selHost);
  }

  function showBubble() {
    const text = norm(selectionText());
    if (text.length < 12) {
      if (selBubble) selBubble.style.display = "none";
      return;
    }
    ensureSelUI();
    const sel = window.getSelection();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    selBubble.style.left = Math.min(rect.right + 8, window.innerWidth - 20) + "px";
    selBubble.style.top = Math.max(4, rect.top - 2) + "px";
    selBubble.style.display = "";
  }

  document.addEventListener("mouseup", () => setTimeout(showBubble, 30));
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey) setTimeout(showBubble, 30);
  });
  document.addEventListener("selectionchange", () => {
    if (!selectionText() && selBubble) selBubble.style.display = "none";
  });

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

  // ---------- startup & test hooks ----------

  function initialScan() {
    if (IS_TOP) {
      const qs = detectQuestions();
      if (qs.length) {
        ensureUI();
        shadow
          .querySelector(".dot")
          .setAttribute(
            "title",
            `${qs.length} question${qs.length > 1 ? "s" : ""} — ⌥Q answers all`,
          );
      }
    }
    // Test hooks:
    //  #qh-auto        → ⌥Q flow (all detected questions)
    //  #qh-stealth     → simulate a click inside question 1, then ⌥A
    //  #qh-select      → select question 1 text only, then ⌥A
    //  #qh-select-mc   → select whole question 1 block (with options), then ⌥A
    const h = location.hash;
    if (h === "#qh-auto") setTimeout(() => answerAllDetected(), 600);
    if (h === "#qh-stealth") setTimeout(testStealth, 600);
    if (h === "#qh-select" || h === "#qh-select-mc") setTimeout(testSelect, 600);
  }

  function testStealth() {
    const legend = document.querySelector("legend");
    if (!legend) return;
    const r = legend.getBoundingClientRect();
    lastClick = {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      t: Date.now(),
    };
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
