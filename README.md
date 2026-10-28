# Quiz Helper

A discreet browser extension that helps you answer quiz-style questions on the web using Apple’s on-device Foundation Model on Mac.

It detects question blocks, extracts the prompt and multiple-choice options, sends them to a local native host, and shows the answer in a compact corner panel without inserting answers directly next to the question.

## Why this project exists

Many quiz and assessment sites make it hard to answer questions in a low-profile way. Quiz Helper is designed to be:

- Quiet and non-intrusive
- Focused on Mac + Apple Intelligence users
- Fast because inference runs on-device
- Useful for multiple-choice and multi-select question patterns

## Key features

- Detects quiz questions from common page layouts
- Supports single-answer and multi-select questions
- Shows results in a small corner panel instead of injecting content into the page
- Keyboard shortcuts:
  - Alt + A: answer the question under the cursor or selected text
  - Alt + Q: answer all detected questions on the page
- Optional spoken answers via the popup toggle
- Built with Chrome extension APIs and a native messaging host for local model access

## How it works

1. The content script scans the webpage DOM and identifies likely question groups.
2. When you trigger a shortcut or click the bubble, the extension extracts the relevant question and answer options.
3. The background worker sends the request to the local native messaging host.
4. The native host calls the Apple on-device model.
5. The answer is returned to the extension and displayed in a compact panel.

## Product screenshots / UI

The extension popup includes a quick status check and a simple toggle for spoken answers.

## Tech stack

- JavaScript
- Chrome Manifest V3 extension
- Native Messaging API
- Apple Foundation Model / on-device inference on macOS

## Project structure

```text
.
├── manifest.json      # Chrome extension manifest
├── background.js      # Background worker and native messaging bridge
├── content.js         # DOM inspection, question detection, and UI injection
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic and connection checks
└── README.md          # Project documentation
```

## Installation

### Prerequisites

- macOS
- Chrome or Chromium-based browser with extension developer mode enabled
- Apple Intelligence / on-device model support enabled in System Settings

### Steps

1. Clone the repository:

```bash
git clone https://github.com/nihar-landge/quiz-helper.git
cd quiz-helper
```

2. Open your browser and go to the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`

3. Turn on `Developer mode`.

4. Click `Load unpacked` and select the project folder.

5. Reload the extension if needed and open a quiz page.

6. Use the shortcuts:
   - `Alt + A` to answer the current question
   - `Alt + Q` to answer all detected questions on the page

### Native host setup

The extension depends on a local native messaging host to connect to the local Apple model. If your environment requires it, install and register the host in the system configuration, then reload the extension.

## Browser behavior

The extension is intentionally designed to be subtle:

- It does not auto-submit or click on pages.
- It does not paste answers directly into the page.
- It keeps answers in a small panel for review.

This makes it safer for assisted review and better for situations where the user wants to compare answers privately.

## Usage examples

### Answer one question

- Click inside the question area
- Press `Alt + A`
- The answer appears in the small corner panel

### Answer every detected question

- Press `Alt + Q`
- The extension processes each detected question in sequence

### Optional spoken answers

- Open the extension popup
- Toggle `Speak answers`
- The result can be voiced through connected audio devices

## Notes

This project is tailored for local, privacy-first on-device inference and is best suited for macOS users with Apple Intelligence enabled.

## License

This project does not currently declare a license in the repository. If you plan to distribute or publish it, add an appropriate open-source license before release.

## Contributing

Contributions are welcome. If you want to improve the question detector, UI, or native host integration, open a pull request with a clear summary of the change.

## Author

- nihar-landge

## Status

Prototype / actively evolving. The core extension behavior is in place, and the project is ready for further refinement, polish, and packaging.

---

Made for a low-noise, privacy-conscious quiz assistant on Mac.




















































































































































































































































































































































































































a
