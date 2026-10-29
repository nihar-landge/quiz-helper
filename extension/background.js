// Quiz Helper — background service worker.
// Owns the native-messaging connection to the local host, which talks to `fm`
// (Apple's on-device Foundation Model). Requests are answered strictly
// one at a time because the on-device model handles one inference at a time.

const HOST_NAME = "com.sunbeam.quizhelper";
const REQUEST_TIMEOUT_MS = 120000;

let port = null;
let nextSeq = 1;
const pending = new Map(); // seq -> {resolve, reject, timer}
const queue = [];
let busy = false;

function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener((msg) => {
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.requestId);
    entry.resolve(msg);
  });
  port.onDisconnect.addListener(() => {
    const err = new Error(
      chrome.runtime.lastError?.message ||
        "Native host not reachable. Run host/install.sh, then reload the extension."
    );
    port = null;
    // Fail everything in flight so callers get an error instead of hanging.
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  });
  return port;
}

function callHost(payload, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const p = connect();
    const seq = nextSeq++;
    const msg = { ...payload, requestId: seq };
    pending.set(seq, {
      resolve,
      reject,
      timer: setTimeout(() => {
        pending.delete(seq);
        reject(new Error("Timed out waiting for the on-device model"));
      }, timeoutMs),
    });
    try {
      p.postMessage(msg);
    } catch (e) {
      pending.delete(seq);
      reject(e);
    }
  });
}

async function processQueue() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const { payload, send } = queue.shift();
    try {
      const result = await callHost(payload);
      send(result);
    } catch (e) {
      send({ ok: false, error: String(e.message || e) });
    }
  }
  busy = false;
}

function enqueue(payload, send) {
  queue.push({ payload, send });
  processQueue();
}

// Keep the last answers so the popup can show them even after the
// notifications have been dismissed.
const HISTORY_KEY = "answers";

async function saveHistory(req, res) {
  try {
    const entry = {
      ts: Date.now(),
      question: String(req.question || "").slice(0, 160),
      ok: !!(res && res.ok),
      letter: res?.optionLetter || "",
      text: String(res?.answerText || "").slice(0, 120),
      reason: String(res?.oneLineReason || "").slice(0, 160),
      error: res && !res.ok ? String(res.error || "").slice(0, 160) : "",
    };
    const { [HISTORY_KEY]: answers = [] } = await chrome.storage.local.get(HISTORY_KEY);
    answers.unshift(entry);
    if (answers.length > 30) answers.length = 30;
    await chrome.storage.local.set({ [HISTORY_KEY]: answers });
  } catch (e) {
    /* history is best-effort */
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "ping") {
    callHost({ type: "ping" }, 15000)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async response
  }
  if (msg?.type === "batchDone") {
    // Completion summary notification; respond immediately, host notifies async.
    chrome.storage?.local.get({ notify: true }, ({ notify }) => {
      callHost(
        {
          type: "batchDone",
          total: msg.total | 0,
          ok: msg.ok | 0,
          failed: msg.failed | 0,
          notify: !!notify,
        },
        15000
      ).catch(() => {});
    });
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "answer") {
    chrome.storage?.local.get({ speak: false, notify: true }, ({ speak, notify }) => {
      enqueue(
        {
          type: "answer",
          question: msg.question,
          options: msg.options,
          multi: !!msg.multi,
          batch: msg.batch || null,
          speak: !!speak,
          notify: !!notify,
        },
        (res) => {
          saveHistory(msg, res);
          sendResponse(res);
        }
      );
    });
    return true;
  }
  return false;
});

chrome.commands?.onCommand.addListener((command) => {
  if (command !== "toggle-overlay") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0])
      chrome.tabs.sendMessage(tabs[0].id, { type: "toggleOverlay" }, () =>
        void chrome.runtime.lastError
      );
  });
});
