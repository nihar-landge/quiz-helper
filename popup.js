const statusEl = document.getElementById("status");
const sttext = document.getElementById("sttext");
const msg = document.getElementById("msg");
const speakBox = document.getElementById("speak");

// restore the voice toggle
chrome.storage.local.get({ speak: false }, ({ speak }) => {
  speakBox.checked = !!speak;
});
speakBox.addEventListener("change", () => {
  chrome.storage.local.set({ speak: speakBox.checked });
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
