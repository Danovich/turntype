#!/usr/bin/env python3
"""
Demo flow for the README's GIF: plays turntype in a real Claude Code session in an iTerm2 window,
at a human pace, while you screen-record the window.

  python3 -I tests/live/demo-flow.py setup   # a demo store, then a window with Claude Code
  # start recording the window
  python3 -I tests/live/demo-flow.py run     # the flow; your store comes back at the end

The flow, about 35 seconds: a prompt, the invitation, 1, a flow test with one typo until Claude is
done, its card closed with x; then /type, time 15 picked in the toolbar and played out to a new
personal best and its toast. The demo store sets today and a 3-day streak, a time 15 best to beat and a few past results
for the sparklines. `run` makes one model call (a short story).
"""

from __future__ import annotations

import importlib.util
import json
import random
import shutil
import sys
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("iterm_probe", HERE / "iterm-probe.py")
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

STATE = Path(tempfile.gettempdir()) / "turntype-demo.json"
COLUMNS, ROWS = 100, 30
# Short: the flow test lasts as long as Claude writes. The personal best comes on the time 15 card.
ASK = "Write a 150-word story about a typist. Plain text, no tools."
MINUTE_MS = 60_000


def demo_store() -> dict:
    """Today 2 of 5 minutes and a 3-day streak; a time 15 best of 35 wpm to beat; a rising week of each."""
    now_ms = int(time.time() * 1000)
    today = date.today()
    day = lambda back: (today - timedelta(days=back)).isoformat()
    history = [
        {"key": key, "at": now_ms - back * 86_400_000 - 3_600_000, "wpm": wpm, "accuracy": 95}
        for key, top in (("flow:english_1k", 45), ("time:15:english_1k", 35))
        for back, wpm in [(5, top - 9), (4, top - 6), (3, top - 4), (2, top - 5), (1, top - 2), (0, top)]
    ]
    return {
        "settings": {"mode": "flow", "counts": {"time": 15, "words": 10}, "wordList": "english_1k"},
        "personalBests": {
            "flow:english_1k": {"wpm": 45, "accuracy": 95, "at": now_ms - 3_600_000},
            "time:15:english_1k": {"wpm": 35, "accuracy": 95, "at": now_ms - 3_600_000},
        },
        "history": history,
        "daily": {
            day(2): {"tests": 2, "activeMs": 4 * MINUTE_MS},
            day(1): {"tests": 3, "activeMs": 6 * MINUTE_MS},
            day(0): {"tests": 2, "activeMs": 2 * MINUTE_MS + 10_000},
        },
        "bigrams": {},
    }


def human_type(win, text: str) -> None:
    """Key by key, with the uneven gaps of a person: a little faster inside a word, a pause at a space."""
    for character in text:
        win.send(character)
        time.sleep(random.uniform(0.07, 0.13) + (0.08 if character == " " else 0.0))


def setup() -> None:
    backup = Path(tempfile.mkdtemp(prefix="turntype-demo-store-"))
    for store in probe.STORE_DIR.glob("turntype_*.json"):
        shutil.copy2(store, backup / store.name)
        store.write_text(json.dumps(demo_store()))
    win = probe.Window()
    probe.osa(f'tell application "iTerm2" to tell current session of window id {win.id} to set columns to {COLUMNS}')
    probe.osa(f'tell application "iTerm2" to tell current session of window id {win.id} to set rows to {ROWS}')
    STATE.write_text(json.dumps({"window": win.id, "backup": str(backup)}))
    win.send(f"cd {probe.REPO} && clear && claude --plugin-dir .")
    win.send(probe.ENTER)
    p = probe.Probe(win, backup)
    if not p.wait_for(lambda s: any(line.startswith("❯") for line in s), timeout=30):
        print("Claude Code did not start")
        return
    probe.osa(f'tell application "iTerm2" to set index of window id {win.id} to 1')
    probe.osa('tell application "iTerm2" to activate')
    print(f"Ready: window {win.id}. Start recording it, then run:  python3 -I tests/live/demo-flow.py run")


class Window(probe.Window):
    def __init__(self, window_id: str) -> None:  # an open window, not a new one
        self.id = window_id


def play_words(p, win, count: int, typo_at: int | None = None, last_without_space: bool = False) -> None:
    """Types the next `count` words of the line on show; `typo_at`: that word gets one wrong letter, left in."""
    for index in range(count):
        word = p.current()
        if index == typo_at and len(word) > 2:
            word = word[0] + ("x" if word[1] != "x" else "z") + word[2:]
        is_last = index == count - 1
        human_type(win, word if is_last and last_without_space else word + " ")
        p.place += 1


def run() -> None:
    state = json.loads(STATE.read_text())
    win = Window(state["window"])
    p = probe.Probe(win, Path(tempfile.mkdtemp()))
    try:
        # 1. The prompt, all at once.
        win.send(ASK)
        time.sleep(0.5)
        p.enter(ASK)

        # 2. The invitation, read for a beat.
        p.wait_for(lambda s: "press 1: type while you wait" in probe.band_line(s), timeout=15, step=0.2)
        time.sleep(1.0)

        # 3. Open the game, type, one typo left in; on until Claude is done, then the word's space.
        win.send("1")
        time.sleep(0.8)
        p.new_test()
        play_words(p, win, 2, typo_at=1)
        deadline = time.time() + 60
        while time.time() < deadline and "finish the word" not in probe.pane_status(p):
            play_words(p, win, 1)
        play_words(p, win, 1)
        if not p.wait_for(lambda s: probe.pane_rows(s) is not None and probe.re.match(r"\d+ wpm", probe.pane_rows(s)[0].strip()) is not None, timeout=5, step=0.2):
            raise RuntimeError("the flow test did not end at the space after Claude was done")

        # 4. The flow card for a beat (it takes no key in its first second), then x closes it.
        time.sleep(1.6)
        win.send("x")
        if not p.wait_for(lambda s: probe.pane_rows(s) is None, timeout=4, step=0.2):
            raise RuntimeError("x did not close the card")
        time.sleep(0.8)

        # 5. /type, time 15 picked by keyboard and played out: a new personal best and its toast.
        human_type(win, "/type")
        time.sleep(0.5)
        p.enter("/type")
        time.sleep(1.0)
        for key in (probe.TAB, probe.TAB, probe.TAB):  # the list, flow, time
            win.send(key)
            time.sleep(0.3)
        p.enter()
        time.sleep(0.5)
        win.send(probe.TAB)  # 15
        time.sleep(0.3)
        p.enter()
        time.sleep(0.6)
        p.new_test()
        deadline = time.time() + 40
        while time.time() < deadline and not p.is_card(0):
            play_words(p, win, 1)
        time.sleep(3.0)
        print("Done. Stop recording; close the window when you like.")
    finally:
        for saved in Path(state["backup"]).iterdir():
            shutil.copy2(saved, probe.STORE_DIR / saved.name)
        print("Your store is back.")


if __name__ == "__main__":
    {"setup": setup, "run": run}[sys.argv[1] if len(sys.argv) > 1 else "setup"]()
