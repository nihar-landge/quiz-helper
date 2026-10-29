const statusEl = document.getElementById("status");
const sttext = document.getElementById("sttext");
const msg = document.getElementById("msg");
const speakBox = document.getElementById("speak");
const notifyBox = document.getElementById("notify");

// restore the voice toggle
chrome.storage.local.get({ speak: false, notify: true }, ({ speak, notify }) => {
  speakBox.checked = !!speak;
  notifyBox.checked = !!notify;
});
speakBox.addEventListener("change", () => {
  chrome.storage.local.set({ speak: speakBox.checked });
});
notifyBox.addEventListener("change", () => {
  chrome.storage.local.set({ notify: notifyBox.checked });
});

function check() {
  sttext.textContent = "checking…";
  statusEl.className = "st";
  msg.textContent = "";
  chrome.runtime.sendMessage({ type: "ping" }, (res) => {
    if (chrome.runtime.lastError) {
      statusEl.className = "st bad";
      sttext.textContent = "extension error";
      msg.textContent = chrome.runtime.lastError.message;
      return;
    }
    if (res?.ok && res.fmAvailable) {
      statusEl.className = "st ok";
      sttext.textContent = "on-device model ready";
    } else if (res?.ok) {
      statusEl.className = "st bad";
      sttext.textContent = "model unavailable";
      msg.textContent = "Enable Apple Intelligence in System Settings.";
    } else {
      statusEl.className = "st bad";
      sttext.textContent = "host not reachable";
      msg.textContent = res?.error || "Run host/install.sh, then reload the extension.";
    }
  });
}

document.getElementById("retry").addEventListener("click", check);
check();

// ---------- recent answers ----------

const answersEl = document.getElementById("answers");
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

async function renderAnswers() {
  const { answers = [] } = await chrome.storage.local.get("answers");
  if (!answers.length) {
    answersEl.innerHTML = '<div class="empty">nothing yet — answers you request are kept here</div>';
    return;
  }
  answersEl.innerHTML = answers
    .slice(0, 12)
    .map((a) => {
      const main = a.ok
        ? `${a.letter ? "<b>" + esc(a.letter) + "</b> · " : ""}<span class="a">${esc(a.text)}</span>`
        : `<b>error</b> · <span class="a">${esc(a.error)}</span>`;
      return `<div class="ans${a.ok ? "" : " err"}" title="${esc(a.reason || a.error)}">${main}<div class="qn">${esc(
        a.question
      )}</div></div>`;
    })
    .join("");
}

document.getElementById("clear").addEventListener("click", async () => {
  await chrome.storage.local.set({ answers: [] });
  renderAnswers();
});

renderAnswers();
