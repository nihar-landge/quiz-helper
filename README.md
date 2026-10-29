# Quiz Helper — on-device quiz answers for Chrome

![platform](https://img.shields.io/badge/macOS-26%2B%20Apple%20Silicon-black)
![browser](https://img.shields.io/badge/Chrome-MV3%20extension-4285F4)
![privacy](https://img.shields.io/badge/privacy-100%25%20on--device-34A853)

A Chrome extension that answers multiple-choice **and** open-ended quiz
questions on any website using **Apple's on-device Foundation Model**
(Apple Intelligence). Fully local: no API keys, no cloud calls, no cost.

Fully invisible by design: **nothing is drawn on the page** — answers arrive
as macOS notifications, optionally spoken aloud. The extension never clicks
anything for you.

---

## Features

- **Works on any site** — no per-site adapters needed:
  - click inside a question and press ⌥A (no text selection required),
  - or select the question text (option lines like `A) Venus` are recognized),
  - or press ⌥Q to answer every question detected on the page.
- **Generic question detection**: native radio/checkbox inputs, Google
  Forms–style `role=radio` / `role=option` widgets, listboxes, and common
  option-class patterns — plus a text-block fallback around your click.
- **Structured answers** via guided generation: option letter(s), option
  text, and a one-line reason (hover/notification subtitle).
- **Multi-answer questions** (checkboxes) return all correct letters.
- **Open-ended questions** (no options found) get a direct short answer.
- **Delivery**: macOS notification (default), speech via `say` (routes to
  AirPods — zero visual), or both.
- **Runs inside iframes**; scroll-proof click targeting; errors arrive as
  notifications too — failures are never silent.

## How it works

```
┌──────────────────┐  native messaging   ┌───────────┐  exec   ┌─────────────────────────┐
│  Chrome extension│ ───────(stdio)────▶ │  host.py  │ ──────▶ │ fm respond              │
│  content script  │   JSON messages     │  (Python) │         │ Apple on-device model   │
└──────────────────┘                     └───────────┘         └───────────┬─────────────┘
        ▲ click / ⌥A / ⌥Q                queue, 1 at a time                │ JSON result
                                                                         ▼
                                                          osascript notification
                                                          say  (optional voice)
```

1. The content script captures what you clicked/selected and, on request,
   extracts the question (and option texts) from the page.
2. The service worker sends it to a small **native messaging host** — the
   only official way a Chrome extension can talk to a local program.
3. The host runs `fm respond --no-stream --greedy --schema …` against Apple's
   on-device model and gets strict JSON back (guided generation).
4. The host delivers the answer as a notification and/or speech.

## Requirements

| | |
|---|---|
| Mac | Apple Silicon (M1 or later) |
| macOS | 26 (Tahoe) or newer — ships the `fm` CLI |
| Apple Intelligence | **On** — System Settings → Apple Intelligence & Siri |
| Python 3 | stock `/usr/bin/python3` works (stdlib only) |
| Browser | Google Chrome |

Verify the model is reachable: `fm available` → should print
`System model available`. (First ever use may require `fm license` to accept
Apple's terms.)

## Setup

```bash
git clone https://github.com/nihar-landge/quiz-helper.git
cd quiz-helper
./host/install.sh
```

`install.sh` picks a working `python3`, generates the `host.sh` wrapper, and
registers the native host with Chrome (writing **both** the classic
`allowed_extensions` and the newer `allowed_origins` manifest keys).

Then load the extension:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select the `extension/` folder

The extension ID is pinned to
`gflgnmhebaeidmlifgjbngbihpdjneao` by a fixed key in `manifest.json`
— the host only accepts that ID. Keep the same `manifest.json` key and the
ID survives reinstalls.

## Usage

| You do | You get |
|---|---|
| Click once inside a question, press **⌥A** | Notification with the answer (~3–7 s) |
| Select the question text, press **⌥A** | Same; `A) …` lines become recognized options |
| Press **⌥Q** | All detected questions answered, one by one |

- ⌥A needs **no selection** — a single click anywhere inside the question.
  The click is remembered for 5 minutes and survives scrolling.
- **Batches**: ⌥Q answers every detected question one by one, and each
  notification is numbered (`Answer 3/10: A — Queue`) with a final
  **"batch done — 10/10 answered"** summary. Every answer (and any error) is
  also kept in the toolbar popup's **Recent answers** list, so nothing is
  lost if you miss the banners — click the extension icon anytime to read
  them all.
- Answers for multi-answer (checkbox) questions list every correct letter
  (`A,C`). Selections with no recognizable options get a short direct answer.
- Toolbar popup: connection/model status, **Speak answers** and
  **macOS notifications** toggles, and the answers history.

## Testing

```bash
cd test && python3 -m http.server 8765
```

| Page | Exercises |
|---|---|
| `quiz.html` | fieldset/legend markup; 5 questions incl. a checkbox multi-answer |
| `forms-style.html` | Google-Forms-style `role=radio` widgets (question outside the group) |
| `plain.html` | plain divs + headings, no fieldset |
| `article.html` | no quiz at all — detection must find nothing |

Automated hooks (localhost / `file:` pages only): append `#qh-auto`
(answer all), `#qh-stealth` (simulate click + ⌥A) or `#qh-select-mc`
(select question + options + ⌥A) to the URL.

## Project structure

```
quiz-helper/
├── extension/            # load this folder in chrome://extensions
│   ├── manifest.json     # MV3; fixed key → stable extension ID
│   ├── content.js        # detection, click/selection capture, shortcuts
│   ├── background.js     # native-messaging client, serial request queue
│   └── popup.html/js     # status + Speak/Notify toggles
├── host/
│   ├── host.py           # native messaging host (stdlib only)
│   ├── install.sh        # one-time registration with Chrome
│   └── extension_key.pem # local only — keep private, not needed for unpacked loading
└── test/                 # sample quiz pages (see Testing)
```

Generated at install time (not in git): `host/host.sh`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No notification at all | Popup shows status: "host not reachable" → run `./host/install.sh`, reload the extension |
| Some answers missing in a batch | Notifications replace each other on screen — open the popup's **Recent answers** list; failed ones appear there with the error |
| "model unavailable" | Enable Apple Intelligence; check `fm available`; accept terms with `fm license` |
| Wrong question answered | Click closer to the question text, or select the exact text instead |
| Multi-select missed | Make sure the question says "select all that apply" in its text |
| Logs | `~/Library/Logs/quizhelper.log` |

## Privacy

Questions and options are processed **only** by the on-device model on your
Mac. No network requests are made by the extension or the host; nothing is
stored beyond a local log file and the two settings toggles.

## Limitations

- `<select>` dropdowns and image/canvas-rendered questions aren't
  auto-detected — select the text for those.
- ⌥Q answers questions in the frame where you pressed it (iframes are
  supported individually).
- ~3–7 s per answer (on-device inference, strictly serial).
- Chrome changes its native-messaging manifest format occasionally; the
  installer writes both the old and new allow-list keys.

## Fair use

This is a study aid for practice quizzes and self-testing. It does not hide
from screen recording or proctoring software, and using it on graded
assessments may violate your institution's policies — use responsibly.
