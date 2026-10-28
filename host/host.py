#!/usr/bin/env python3
"""Quiz Helper — Chrome native messaging host.

Bridges Chrome's extension messaging protocol (4-byte little-endian length
prefixed JSON over stdio) to Apple's on-device Foundation Model via the
`fm` CLI. Runs entirely on this Mac.

Messages from the extension:
  {"type": "ping", "requestId": N}
  {"type": "answer", "requestId": N, "question": str,
   "options": [{"letter": "A", "text": str}, ...]}

Replies to the extension:
  {"type": "pong", "requestId": N, "ok": true, "fmAvailable": bool}
  {"type": "result", "requestId": N, "ok": true, "optionLetter": str,
   "answerText": str, "oneLineReason": str}
  {"requestId": N, "ok": false, "error": str}
"""

import json
import os
import subprocess
import sys
import tempfile
import time

LOG_FILE = os.path.expanduser("~/Library/Logs/quizhelper.log")
SCHEMA_FILE = os.path.join(tempfile.gettempdir(), "quizhelper_answer_v2.schema.json")

_fm_available = None  # cached result of `fm available`


def log(msg):
    try:
        with open(LOG_FILE, "a") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except OSError:
        pass


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = __import__("struct").unpack("<I", raw_len)
    if length == 0 or length > 4 * 1024 * 1024:
        return None
    data = sys.stdin.buffer.read(length)
    try:
        return json.loads(data.decode("utf-8"))
    except ValueError:
        return {}


def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(
        __import__("struct").pack("<I", len(data)) + data
    )
    sys.stdout.buffer.flush()


def fm_available():
    global _fm_available
    if _fm_available is None:
        try:
            r = subprocess.run(
                ["fm", "available"],
                capture_output=True,
                text=True,
                timeout=20,
            )
            _fm_available = r.returncode == 0 and "available" in r.stdout.lower()
        except Exception:
            _fm_available = False
    return _fm_available


def ensure_schema():
    # Generate the schema with `fm` itself so its format is always valid.
    # optionLetter is optional: empty for open-ended (no-options) questions.
    if os.path.exists(SCHEMA_FILE):
        return
    cmd = [
        "fm", "schema", "object", "--name", "QuizAnswer",
        "--string", "optionLetter",
        "--description",
        "The letter (A, B, C, ...) of the correct option. If multiple options are correct, list all letters separated by commas. Leave empty if no options were given.",
        "--optional",
        "--string", "answerText",
        "--description", "The exact text of the correct option, or a concise answer if no options were given.",
        "--string", "oneLineReason",
        "--description", "One short sentence explaining why.",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError("fm schema failed: %s" % (r.stderr or r.stdout).strip()[:300])
    with open(SCHEMA_FILE, "w") as f:
        f.write(r.stdout)


INSTRUCTIONS = (
    "You are a quiz answer assistant. You get one question, usually with "
    "lettered options. If options are provided: determine the correct option; "
    "use ONLY the letters that were provided — never invent one; pick exactly "
    "ONE letter unless the question says to select all that apply (then list "
    "every correct letter); set answerText to the option text. If no options "
    "are provided: leave optionLetter empty and put a concise answer (under "
    "20 words) in answerText. Answer from general knowledge; do not invent "
    "option text."
)


def run_fm(question, options, multi=False):
    lines = ["Question: " + question]
    if options:
        lines.append("Options:")
        for o in options:
            lines.append("%s) %s" % (o.get("letter", "?"), o.get("text", "")))
        letters = ", ".join(o.get("letter", "?") for o in options)
        lines.append("(Valid option letters: %s)" % letters)
        if multi:
            lines.append(
                "This question asks to select all that apply — list every correct letter."
            )
    prompt = "\n".join(lines)

    ensure_schema()

    cmd = [
        "fm", "respond", "--no-stream", "--greedy",
        "--schema", SCHEMA_FILE,
        "--instructions", INSTRUCTIONS,
        prompt,
    ]
    started = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=110)
    log("fm took %.1fs, rc=%d" % (time.time() - started, r.returncode))

    if r.returncode != 0:
        raise RuntimeError(
            "fm exited %d: %s" % (r.returncode, (r.stderr or r.stdout or "").strip()[:300])
        )

    out = r.stdout.strip()
    # Output should be a JSON object; find it defensively.
    start, end = out.find("{"), out.rfind("}")
    if start == -1 or end == -1:
        raise RuntimeError("Unexpected fm output: %s" % out[:200])
    parsed = json.loads(out[start : end + 1])
    option_letter = str(parsed.get("optionLetter") or "").strip()
    if not options:
        option_letter = ""  # open-ended: never report a letter
    return {
        "ok": True,
        "optionLetter": option_letter,
        "answerText": str(parsed.get("answerText", "")).strip(),
        "oneLineReason": str(parsed.get("oneLineReason", "")).strip(),
    }


def speak_answer(result):
    """Say the answer aloud (routes to the Mac's selected output, e.g. AirPods)."""
    letter = (result.get("optionLetter") or "").strip()
    text = (result.get("answerText") or "").strip()
    spoken = (letter + ". " if letter else "") + text
    if not spoken.strip():
        return
    try:
        subprocess.Popen(
            ["say", spoken[:200]],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log("spoke: %s" % spoken[:60])
    except Exception as e:  # noqa: BLE001 — voice is best-effort
        log("say failed: %r" % e)


def _clean(s):
    """Collapse whitespace/newlines — raw newlines break AppleScript strings."""
    return " ".join(str(s or "").split())


def _notify(title, subtitle, body):
    script = 'display notification "%s" with title "%s"%s' % (
        _clean(body).replace('"', '\\"'),
        _clean(title).replace('"', '\\"'),
        ' subtitle "%s"' % _clean(subtitle).replace('"', '\\"') if subtitle else "",
    )
    try:
        subprocess.Popen(
            ["osascript", "-e", script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log("notified: %s — %s" % (title, _clean(body)[:60]))
    except Exception as e:  # noqa: BLE001 — notification is best-effort
        log("notify failed: %r" % e)


def notify_answer(result):
    """Send a macOS notification with the answer (appears in Notification Centre)."""
    letter = (result.get("optionLetter") or "").strip()
    text = (result.get("answerText") or "").strip()
    reason = (result.get("oneLineReason") or "").strip()

    title = ("Answer: " + letter) if letter else "Answer"
    body = text[:120]
    subtitle = reason[:80] if reason else ""
    _notify(title, subtitle, body)


def notify_error(error_text):
    """Tell the user something went wrong (never fail silently)."""
    _notify("Quiz Helper error", "", str(error_text)[:120])


def error_result(rid, error_text, notify_flag):
    log("error: %s" % error_text)
    if notify_flag:
        notify_error(error_text)
    return {"requestId": rid, "ok": False, "error": error_text}


def handle(msg):
    rid = msg.get("requestId")
    mtype = msg.get("type")

    if mtype == "ping":
        return {
            "type": "pong",
            "requestId": rid,
            "ok": True,
            "fmAvailable": fm_available(),
        }

    if mtype == "answer":
        question = msg.get("question", "")
        options = msg.get("options") or []
        notify_flag = bool(msg.get("notify"))
        if not question:
            return error_result(rid, "empty question", notify_flag)
        if not fm_available():
            return error_result(
                rid,
                "Apple's on-device model is not available. Enable Apple "
                "Intelligence in System Settings and make sure `fm` works "
                "in Terminal.",
                notify_flag,
            )
        try:
            result = run_fm(question, options, multi=bool(msg.get("multi")))
            log(
                "answer: %s -> %s (%s)"
                % (question[:60], result.get("optionLetter"), result.get("answerText", "")[:40])
            )
            result["requestId"] = rid
            result["type"] = "result"
            if msg.get("speak"):
                speak_answer(result)
            if notify_flag:
                notify_answer(result)
            return result
        except subprocess.TimeoutExpired:
            return error_result(rid, "model timed out", notify_flag)
        except Exception as e:  # noqa: BLE001 — report everything to the UI
            return error_result(rid, str(e)[:300], notify_flag)

    return {"requestId": rid, "ok": False, "error": "unknown message type"}


def main():
    log("host started (pid %d, python %s)" % (os.getpid(), sys.version.split()[0]))
    try:
        while True:
            msg = read_message()
            if msg is None:
                log("stdin closed (eof) — exiting")
                break
            if not msg:
                send_message({"ok": False, "error": "bad message"})
                continue
            send_message(handle(msg))
    except BrokenPipeError:
        log("broken pipe — chrome closed the port")
    except Exception:
        import traceback

        log("fatal: " + traceback.format_exc())
    finally:
        log("host stopped")


if __name__ == "__main__":
    main()
