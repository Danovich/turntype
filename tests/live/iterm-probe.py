#!/usr/bin/env python3
"""
Live probe: drives turntype in a real Claude Code session in an iTerm2 window, reads what is drawn
and checks it, with screenshots at the moments worth a look. What the test kit cannot do: real
focus, the host's own field, timing, resizes, Esc, a time test running out, a model turn.

Run: python3 -I tests/live/iterm-probe.py [--turns] [--shots DIR]
  --turns   also run the cases that need a model turn (Claude is done, a permission dialog)
  --shots   where screenshots go (default: a temp folder, printed at the end)

Needs macOS, iTerm2, and Screen Recording allowed for iTerm. Your turntype store is copied
before and put back after; the probe plays on a clean one (flow, english_1k, no history), so its
tests never count in your stats and every run starts the same. Don't type in its window.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
STORE_DIR = Path.home() / ".claude/plugins/store"
COLUMNS, ROWS = 100, 34

ESC, ENTER, TAB, BS, CTRL_X = "\x1b", "\r", "\t", "\x7f", "\x18"
# A clean store, but for one weak letter pair, so the ready row shows the practice it brings.
CLEAN_STORE = {
    "settings": {"mode": "flow", "counts": {"time": 30, "words": 25}, "wordList": "english_1k"},
    "bigrams": {"th": {"attempts": 40, "errors": 10}},
}


# ─── iTerm ───────────────────────────────────────────────────────────────────────────────────

def osa(script: str, *args: str) -> str:
    done = subprocess.run(["osascript", "-e", script, *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"osascript: {done.stderr.strip()}")
    return done.stdout.rstrip("\n")


class Window:
    def __init__(self) -> None:
        self.id = osa(
            'tell application "iTerm2"\n'
            "set w to (create window with default profile)\n"
            f"tell current session of w to set columns to {COLUMNS}\n"
            f"tell current session of w to set rows to {ROWS}\n"
            "return id of w\n"
            "end tell"
        )

    def session(self) -> str:
        return f'tell application "iTerm2" to tell current session of window id {self.id}'

    def send(self, text: str) -> None:
        osa(f"on run argv\n{self.session()} to write text (item 1 of argv) newline NO\nend run", text)

    def type_keys(self, text: str, delay: float = 0.06) -> None:
        """One key per change, as a person types: a whole word at once would be a paste."""
        osa(
            "on run argv\n"
            f"{self.session()}\n"
            "repeat with c in characters of (item 1 of argv)\n"
            "write text (c as text) newline NO\n"
            f"delay {delay}\n"
            "end repeat\n"
            "end tell\n"
            "end run",
            text,
        )

    def resize(self, columns: int) -> None:
        osa(f"{self.session()} to set columns to {columns}")

    def screen(self) -> list[str]:
        lines = osa(f"{self.session()} to get contents").split("\n")
        return lines[-ROWS:]

    def shot(self, path: Path) -> None:
        # The capture is of a screen area: the probe's window goes in front first, or another
        # app's window over it would be captured instead.
        osa(f'tell application "iTerm2" to set index of window id {self.id} to 1')
        osa('tell application "iTerm2" to activate')
        time.sleep(0.4)
        bounds = osa(f'tell application "iTerm2" to get bounds of window id {self.id}')
        x1, y1, x2, y2 = (int(v) for v in bounds.split(", "))
        subprocess.run(["screencapture", "-x", "-R", f"{x1},{y1},{x2 - x1},{y2 - y1}", str(path)], check=False)

    def close(self) -> None:
        try:
            osa(f'tell application "iTerm2" to close window id {self.id}')
        except RuntimeError:
            pass


# ─── Reading the screen ──────────────────────────────────────────────────────────────────────

def pane_rows(lines: list[str]) -> list[str] | None:
    """The game pane's body rows, the last framed box on screen; None when no pane shows."""
    bottom = next((i for i in range(len(lines) - 1, -1, -1) if lines[i].lstrip().startswith("╰")), None)
    if bottom is None:
        return None
    top = next((i for i in range(bottom - 1, -1, -1) if lines[i].lstrip().startswith("╭")), None)
    if top is None:
        return None
    return [re.sub(r"^\s*│ ?", "", re.sub(r" ?│\s*$", "", line)) for line in lines[top + 1 : bottom]]


def band_line(lines: list[str]) -> str:
    """The band's row above the prompt, when it draws: the last row offering a press."""
    return next((line.strip() for line in reversed(lines) if "press 1:" in line), "")


def status_anywhere(lines: list[str]) -> str:
    """The field's row wherever the pane sits, inline or docked beside the transcript."""
    pattern = re.compile(r"(\d+:\d\d.*?(?:words?|\d+/\d+)|paused ⋅ type to resume|start typing ⏎ finish|ctrl\+x tab to type).*")
    found = [m.group(0) for m in (pattern.search(line) for line in lines) if m]
    return found[-1].rstrip(" │") if found else ""


def prompt_text(lines: list[str]) -> str:
    row = next((line for line in reversed(lines) if line.startswith("❯")), "❯")
    return row[1:].strip()


# ─── Checks ──────────────────────────────────────────────────────────────────────────────────

class Probe:
    def __init__(self, win: Window, shots: Path) -> None:
        self.win = win
        self.shots = shots
        self.results: list[tuple[str, bool, str]] = []

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.results.append((name, ok, detail))
        print(f"  {'✔' if ok else '✘'} {name}" + ("" if ok else f"\n      {detail}"))
        return ok

    def pane(self, wait: float = 0.6) -> list[str] | None:
        time.sleep(wait)
        return pane_rows(self.win.screen())

    def enter(self, expect: str = "") -> None:
        """Enter, only while the prompt holds `expect`: a key that went astray must never send a prompt."""
        held = prompt_text(self.win.screen())
        if held != expect:
            raise RuntimeError(f"the prompt holds {held!r}, not {expect!r}: Enter not pressed")
        self.win.send(ENTER)

    def shot(self, name: str) -> None:
        self.win.shot(self.shots / f"{len(list(self.shots.iterdir())) + 1:02d}-{name}.png")

    def words(self) -> list[str]:
        """The words of the first line on show: the line being typed."""
        rows = self.pane(0.3) or [""]
        return rows[0].split()

    # Where the current word is: the line being typed and the word's place in it. The line on show
    # starts with the current word's line, so the place is counted here; a new test starts it over.
    line: list[str] = []
    place = 0

    def new_test(self) -> None:
        self.line, self.place = [], 0

    def current(self) -> str:
        if not self.line or self.place >= len(self.line):
            self.line, self.place = self.words(), 0
        return self.line[self.place]

    def commit(self, text: str) -> None:
        """Types `text` and a space as the current word, key by key, and moves to the next word."""
        self.win.type_keys(text + " ")
        self.place += 1

    def type_words(self, count: int) -> None:
        for _ in range(count):
            self.commit(self.current())

    def wait_for(self, predicate, timeout: float = 20.0, step: float = 0.5) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            if predicate(self.win.screen()):
                return True
            time.sleep(step)
        return False

    def status(self) -> str:
        time.sleep(0.3)
        return status_anywhere(self.win.screen())

    def is_card(self, wait: float = 0.3) -> bool:
        rows = self.pane(wait)
        return rows is not None and re.match(r"\d+ wpm", rows[0].strip()) is not None


# ─── Cases ───────────────────────────────────────────────────────────────────────────────────

def open_game(p: Probe) -> None:
    p.win.send("/type")
    time.sleep(0.8)
    p.enter("/type")


def clear_prompt(p: Probe) -> None:
    """Deletes text a key that went astray left in the prompt, while the prompt holds the keys."""
    screen = p.win.screen()
    held = prompt_text(screen)
    rows = pane_rows(screen)
    if held and (rows is None or "ctrl+x tab to type" in rows[3]):
        for _ in range(len(held) + 2):
            p.win.send(BS)
        time.sleep(0.4)


def hide_pane(p: Probe) -> None:
    """Esc on an open pane, so the next keys are the prompt's: a test in progress waits in the band."""
    if pane_rows(p.win.screen()) is not None:
        p.win.send(ESC)
        time.sleep(0.6)


def pane_status(p: Probe) -> str:
    """The field's row and the row under it: the weak pairs before the first key, the status after."""
    rows = p.pane(0.3)
    return f"{rows[3]}  {rows[4]}" if rows is not None and len(rows) > 4 else ""


def ensure_ready(p: Probe) -> None:
    """A fresh test before its first key, whatever an earlier case left: one failure stops nothing."""
    clear_prompt(p)
    for _ in range(4):
        rows = p.pane(0.4)
        if rows is None:
            p.win.send(ESC)
            time.sleep(0.3)
            for _ in range(20):
                p.win.send(BS)
            open_game(p)
            time.sleep(1.2)
            continue
        if "ctrl+x tab to type" in rows[3]:
            p.win.send(CTRL_X + TAB)
            time.sleep(0.6)
            continue
        if re.match(r"\d+ wpm", rows[0].strip()):
            again(p)
            continue
        if "start typing" in rows[3]:
            p.new_test()
            return
        # A test in progress: end it, then again.
        p.enter()
        time.sleep(0.4)
    p.new_test()


def case_open_and_ready(p: Probe) -> None:
    print("open with /type, before the first key")
    open_game(p)
    rows = p.pane(1.5)
    if not p.check("the pane opens", rows is not None, "no framed pane on screen"):
        return
    p.check("five rows", len(rows) == 5, f"{len(rows)} rows: {rows}")
    p.check("two lines of words", all(re.search(r"[a-z]", r) for r in rows[:2]), str(rows[:2]))
    p.check("the dashed rule", set(rows[2].strip()) == {"╌"}, rows[2])
    p.check("the field says start typing, then ⏎ finish", "start typing ⏎ finish" in rows[3], rows[3])
    p.check("the toolbar under the field", rows[4].lstrip().startswith("◍"), rows[4])
    p.shot("ready")


def case_mode_in_use_back_to_field(p: Probe) -> None:
    print("Enter on the mode in use hands the keys back to the field")
    ensure_ready(p)
    # The clean store's mode is flow: the list, then flow. A press on it chooses nothing.
    for key in (TAB, TAB, ENTER):
        p.win.send(key)
        time.sleep(0.3)
    p.win.type_keys("q")
    rows = p.pane()
    screen = p.win.screen()
    p.check("the next key lands in the field, not the prompt", rows is not None and rows[3].lstrip().startswith("q") and prompt_text(screen) == "", f"{rows[3] if rows else None!r} prompt {prompt_text(screen)!r}")
    p.win.send(BS)


def case_first_key_focus(p: Probe) -> None:
    print("the first key: focus, the toolbar going")
    ensure_ready(p)
    p.new_test()
    word = p.current()
    p.win.type_keys(word[0])
    rows = p.pane()
    screen = p.win.screen()
    p.check("the first key lands in the field", rows is not None and rows[3].lstrip().startswith(word[0]), str(rows))
    p.check("the prompt stays empty", prompt_text(screen) == "", prompt_text(screen))
    p.check("the toolbar goes, the status takes its row, five rows", rows is not None and len(rows) == 5 and re.match(r"\d+:\d\d", rows[4].strip()) is not None, str(rows))
    # The status never moves while the word grows: it starts its row at the same column every key.
    starts = set()
    for letter in word[1:]:
        p.win.type_keys(letter)
        row = (p.pane(0.15) or ["", "", "", "", ""])[4]
        starts.add(len(row) - len(row.lstrip()))
    p.check("the status stays put while the word grows", len(starts) == 1, str(starts))
    p.commit("")
    rows = p.pane()
    p.check("the next word's field is empty, no placeholder", rows is not None and "start typing" not in rows[3], rows[3] if rows else "")
    p.check("one word counted, on the status row", rows is not None and "1 word " in rows[4] + " ", rows[4] if rows else "")
    p.check("Claude idle: the flow test says Enter ends it", rows is not None and "∘ Claude is done ⋅ ⏎ finish" in rows[4], rows[4] if rows else "")


def case_typo_and_backspace(p: Probe) -> None:
    print("a typo, Backspace, a word ended short, keys past a word's end")
    word = p.current()
    p.win.type_keys("#")
    p.shot("typo-red")
    p.win.send(BS)
    p.commit(word)
    p.check("Backspace fixed the word: two words", "2 words" in p.status(), p.status())
    # Ended short: the skipped letters are a mistake (red), the next word is current.
    p.commit(p.current()[:1])
    p.shot("skipped-red")
    # Past the end: the extra letters are left out, the field holds the word as cut.
    word = p.current()
    p.win.type_keys(word + "zz")
    rows = p.pane()
    p.check("keys past a word's end are left out of the field", rows is not None and rows[3].lstrip().startswith(word) and "zz" not in rows[3], rows[3] if rows else "")
    p.commit("")


def count_of(status: str) -> str:
    found = re.search(r"(\d+)(?:/\d+)? words?", status) or re.search(r"(\d+)/\d+", status)
    return found.group(1) if found else "?"


def case_spaces_and_backspace_into_word(p: Probe) -> None:
    print("spaces before a word; Backspace in an empty field")
    before = p.status()
    p.win.type_keys("  ")
    p.win.send(BS)
    p.win.send(BS)
    after = p.status()
    p.check("extra spaces and Backspace on an empty field change nothing", count_of(after) == count_of(before), f"{before} → {after}")
    p.check("a finished word stays finished", "paused" in after or count_of(after) != "?", after)


def case_line_moves_up(p: Probe) -> None:
    print("a finished line moves up; the next one is full")
    p.current()
    second = (p.pane() or ["", ""])[1]
    p.type_words(len(p.line) - p.place)
    rows = p.pane()
    p.check("the second line moved up", rows is not None and rows[0].split()[:3] == second.split()[:3], f"{second[:40]} / {rows[0][:40] if rows else ''}")
    p.check("the new second line is full", rows is not None and len(rows[1].rstrip()) > COLUMNS - 30, rows[1] if rows else "")


def case_idle_pause(p: Probe) -> None:
    print("a pause: the clock stops, the next key resumes")
    word = p.current()
    p.win.type_keys(word[:1])
    time.sleep(3.5)
    rows = p.pane(0)
    p.check("the status says paused", rows is not None and "paused ⋅ type to resume" in rows[4], rows[4] if rows else "")
    p.commit(word[1:])
    status = p.status()
    p.check("the next key resumes the clock", re.search(r"\d+:\d\d", status) is not None and "paused" not in status, status)


def case_esc_and_back(p: Probe) -> None:
    print("Esc mid-test, the band, 1 and /type back")
    p.win.send(ESC)
    time.sleep(1)
    screen = p.win.screen()
    p.check("Esc hides the pane", pane_rows(screen) is None, "a pane still shows")
    p.check("the band offers to continue", band_line(screen).startswith("press 1: continue ⋅"), band_line(screen))
    p.win.send("1")
    p.check("1 brings the pane back", p.pane(1.2) is not None, band_line(p.win.screen()))
    p.commit(p.current())
    screen = p.win.screen()
    p.check("keys go to the field after 1", prompt_text(screen) == "", prompt_text(screen))
    for attempt in range(2):
        p.win.send(ESC)
        time.sleep(0.6)
        p.win.send("1")
        p.check(f"Esc and 1 again, fast ({attempt + 1})", p.pane(1.0) is not None, band_line(p.win.screen()))
    p.win.send(ESC)
    time.sleep(0.6)
    open_game(p)
    p.check("/type brings it back too", p.pane(1.2) is not None, band_line(p.win.screen()))


def case_one_with_text_in_prompt(p: Probe) -> None:
    print("1 with text in the prompt types a 1")
    p.win.send(ESC)
    time.sleep(0.6)
    p.win.type_keys("hello1")
    screen = p.win.screen()
    p.check("the pane stays hidden", pane_rows(screen) is None, "a pane opened")
    p.check("the prompt holds hello1", prompt_text(screen).endswith("hello1"), prompt_text(screen))
    for _ in range(6):
        p.win.send(BS)
    time.sleep(0.4)
    p.win.send("1")
    p.check("1 in the cleared prompt opens it", p.pane(1.2) is not None, prompt_text(p.win.screen()))


def check_lockout(p: Probe, label: str) -> None:
    rows = p.pane(0)
    p.check(f"{label}: the result card, five rows", rows is not None and len(rows) == 5 and re.match(r"\d+ wpm", rows[0].strip()) is not None, str(rows))
    # Keys still coming at the end: none of a, x, d acts.
    p.win.type_keys("adx", delay=0.05)
    rows = p.pane(0.2)
    p.check(f"{label}: a, d and x in the first second do nothing", rows is not None and "⏎ again" in rows[3] and "hide details" not in rows[3], str(rows))


def again(p: Probe) -> None:
    time.sleep(1.2)
    p.win.send("a")
    time.sleep(0.6)
    p.new_test()


def case_flow_enter_and_card(p: Probe) -> None:
    print("Enter ends a flow test; the result card and its lockout")
    ensure_ready(p)
    p.win.type_keys(p.current()[:2])
    p.enter()
    time.sleep(0.3)
    check_lockout(p, "flow")
    p.shot("result")
    time.sleep(1.2)
    p.win.send("d")
    rows = p.pane()
    p.check("after the second, d shows the details", rows is not None and rows[1].lstrip().startswith("raw ") and "hide details" in rows[3], str(rows))
    p.win.send("d")
    rows = p.pane()
    p.check("d again hides them", rows is not None and "hide details" not in rows[3], str(rows))
    p.win.send("a")
    rows = p.pane()
    p.check("a starts a new test", rows is not None and "start typing" in rows[3], str(rows))
    p.new_test()
    p.win.type_keys("q")
    rows = p.pane()
    p.check("the new field takes the keys at once", rows is not None and rows[3].lstrip().startswith("q"), str(rows))
    # End that test and start a clean one: the toolbar shows only before the first key.
    p.enter()
    again(p)


def pick(p: Probe, mode_tabs: int, count_tabs: int) -> None:
    """Tab to a mode in the toolbar, open it, Tab to a count, pick it."""
    for _ in range(mode_tabs):
        p.win.send(TAB)
        time.sleep(0.25)
    p.enter()
    time.sleep(0.5)
    for _ in range(count_tabs):
        p.win.send(TAB)
        time.sleep(0.25)
    p.enter()
    time.sleep(0.6)
    p.new_test()


def case_words_test(p: Probe) -> None:
    print("words 10 picked by keyboard, played to the last word")
    ensure_ready(p)
    # From the field: the list, flow, time, words. Words' counts 10 25 50 100: one Tab to 10.
    pick(p, 4, 1)
    rows = p.pane()
    p.check("words 10 in use", rows is not None and "☰ words (10)" in rows[4], rows[4] if rows else "")
    rows = p.pane()
    p.check("the field still takes the keys after the pick", rows is not None and "start typing ⏎ finish" in rows[3], rows[3] if rows else "")
    p.type_words(1)
    p.check("the status counts 1/10", "1/10" in p.status(), p.status())
    p.type_words(8)
    p.check("9/10 before the last word", "9/10" in p.status(), p.status())
    p.win.type_keys(p.current())
    # The run's first fair test: the speeds it reached for the first time, in one toast.
    toast = p.wait_for(lambda s: any("✦" in line and "wpm test" in line for line in s), timeout=4, step=0.3)
    p.check("the last word ends the test with no space", p.is_card(0), str(p.pane(0)))
    p.check("a toast names the first speed reached", toast, "no ✦ … wpm test toast")
    p.shot("words-result")
    again(p)


def case_time_runs_out(p: Probe) -> None:
    print("time 15 runs out by itself, measured over exactly 15 s")
    ensure_ready(p)
    pick(p, 3, 1)
    rows = p.pane()
    p.check("time 15 in use", rows is not None and "◷ time (15)" in rows[4], rows[4] if rows else "")
    start = time.time()
    while time.time() - start < 25 and not p.is_card(0):
        p.commit(p.current())
    p.check("the test ended by itself, five rows", p.is_card(0) and len(p.pane(0) or []) == 5, str(p.pane(0)))
    # The end is seen only after the word typed then: the lockout is checked where the end is known.
    time.sleep(1.2)
    p.win.send("d")
    rows = p.pane()
    if rows is not None and not rows[1].lstrip().startswith("raw "):
        p.win.send("d")
        rows = p.pane()
    p.check("the details say 0:15", rows is not None and "⋅ 0:15 ⋅" in rows[1], rows[1] if rows else "")
    again(p)


def case_keys_after_the_end(p: Probe) -> None:
    print("keys still coming when a test ends stay in the pane")
    ensure_ready(p)
    pick(p, 4, 1)  # words 10
    p.type_words(9)
    # The last word, then letters a fast typist already sent: none reaches the prompt.
    p.win.type_keys(p.current() + " the qu")
    time.sleep(0.5)
    screen = p.win.screen()
    p.check("the card shows", p.is_card(0), str(pane_rows(screen)))
    p.check("no key reached the prompt", prompt_text(screen) == "", prompt_text(screen))
    time.sleep(1.2)
    before = (p.pane(0) or ["", ""])[1].lstrip().startswith("raw ")
    p.win.send("d")
    rows = p.pane()
    p.check("the card still takes its keys: d toggles the details", rows is not None and rows[1].lstrip().startswith("raw ") != before, str(rows))
    p.win.send("d")
    # A stray letter long after the end: still not the prompt's.
    p.win.type_keys("q")
    time.sleep(0.4)
    p.check("a letter on the card later stays out of the prompt", prompt_text(p.win.screen()) == "", prompt_text(p.win.screen()))
    again(p)


def case_paste(p: Probe) -> None:
    print("a paste is no personal best try")
    ensure_ready(p)
    words = p.words()[:3]
    # A real paste: the terminal's bracketed paste, as Cmd+V sends it.
    p.win.send("\x1b[200~" + " ".join(words) + " \x1b[201~")
    time.sleep(0.5)
    p.enter()
    rows = p.pane(1.5)
    p.check("the card says text was pasted", rows is not None and "text was pasted" in rows[0], str(rows))
    again(p)


def case_widths(p: Probe) -> None:
    print("narrow and wide: five rows inline, the dock from 110 columns, the keys kept across")
    ensure_ready(p)
    for columns in (60, 44, 105):
        p.win.resize(columns)
        rows = p.pane(1.5)
        p.check(f"{columns} columns: five rows", rows is not None and len(rows) == 5, str(rows))
        p.shot(f"width-{columns}")
    p.win.resize(COLUMNS)
    time.sleep(1)
    # Typing across a resize keeps every word and the keys; the words need not be right.
    start = int(count_of(p.status()) if count_of(p.status()).isdigit() else 0)

    def typed(label: str, words: int) -> None:
        p.win.type_keys("abc ")
        status, held = p.status(), prompt_text(p.win.screen())
        p.check(label, count_of(status) == str(start + words) and held == "", f"{status!r} prompt {held!r}")

    typed("before a resize: the word counts", 1)
    p.win.resize(70)
    time.sleep(0.8)
    typed("a resize mid-test keeps the count and the keys", 2)
    # Wide: the pane docks beside the transcript and loses the keys; the mod gets them back.
    p.win.resize(150)
    time.sleep(1.5)
    p.shot("width-150-dock")
    typed("docked at 150 columns: the keys reach the field again", 3)
    p.win.resize(COLUMNS)
    time.sleep(1.5)
    typed("back inline: the keys reach the field again", 4)


def case_close(p: Probe) -> None:
    print("x closes; the prompt takes the keys")
    ensure_ready(p)
    # Flow for the turns after: Enter on it picks it, or, in use, hands the keys back to the field.
    for key in (TAB, TAB, ENTER):
        p.win.send(key)
        time.sleep(0.3)
    p.win.type_keys("q")
    p.enter()
    time.sleep(1.4)
    p.win.send("x")
    time.sleep(0.8)
    screen = p.win.screen()
    p.check("x closes the pane", pane_rows(screen) is None, "a pane still shows")
    p.win.type_keys("hi")
    screen = p.win.screen()
    p.check("the prompt takes the keys again", prompt_text(screen).endswith("hi"), prompt_text(screen))
    p.win.send(BS)
    p.win.send(BS)


def case_turn_claude_done(p: Probe) -> None:
    print("a model turn: the invitation, Claude done, finish the word")
    clear_prompt(p)
    hide_pane(p)
    # Long enough that the test starts while Claude still works.
    ask = "Write a story of about 400 words about a typist. Plain text, no tools."
    p.win.send(ask)
    time.sleep(0.5)
    p.enter(ask)
    ok = p.wait_for(lambda s: "press 1: type while you wait" in band_line(s), timeout=12)
    if not p.check("the invitation shows after 3 s", ok, band_line(p.win.screen())):
        return
    p.shot("invitation")
    # Claude Code arms the band's hotkey a moment after the line first draws: a 1 within that
    # moment types a 1. A person reads the line first; the probe waits as long.
    time.sleep(0.5)
    p.win.send("1")
    if not p.check("1 opens the game", p.pane(1.0) is not None, band_line(p.win.screen())):
        return
    # Flow is in use (case_close picked it): the first key at once, while Claude still writes.
    # The first key at once, while Claude still writes: the status says so, then "finish the word"
    # once the turn ends during the test.
    p.win.type_keys("abc ")
    p.check("while Claude works the status says esc: hide", "esc: hide" in pane_status(p), pane_status(p))
    end = time.time() + 90
    while time.time() < end and "finish the word" not in pane_status(p):
        p.win.type_keys("abc ", delay=0.08)
    status = pane_status(p)
    p.shot("claude-done")
    transcript = " / ".join(line.strip() for line in p.win.screen() if line.strip())[-600:]
    p.check("the status says Claude is done ⋅ finish the word", "Claude is done ⋅ finish the word" in status, f"{status} || screen: {transcript}")
    p.win.type_keys("abc ")
    p.check("the next space ends the flow test", p.is_card(0.6), str(p.pane(0)))
    close_test(p)


def close_test(p: Probe) -> None:
    """Ends what is on show and closes the pane: no test left to wait in the band."""
    if pane_rows(p.win.screen()) is None:
        return
    if not p.is_card(0):
        p.enter()
    time.sleep(1.3)
    p.win.send("x")
    time.sleep(0.6)


def case_permission_dialog(p: Probe) -> None:
    print("a permission dialog mid-test: the keys come back")
    clear_prompt(p)
    hide_pane(p)
    # A wait first, so the dialog comes mid-test; then a write, which asks (a read may not).
    ask = "Use the Bash tool twice and nothing else: first sleep 8, then touch /tmp/turntype-probe-dialog"
    p.win.send(ask)
    time.sleep(0.5)
    p.enter(ask)
    if not p.check("the invitation shows", p.wait_for(lambda s: "press 1: type while you wait" in band_line(s), timeout=12), band_line(p.win.screen())):
        return
    time.sleep(0.5)
    p.win.send("1")
    p.pane(1.0)
    p.win.type_keys("ab")
    dialog = p.wait_for(lambda s: any("Do you want to proceed" in line for line in s), timeout=30)
    if not p.check("the permission dialog shows", dialog, "\n".join(p.win.screen()[-12:])):
        return
    p.shot("dialog")
    p.win.send(ENTER)  # Yes, the first choice: the dialog holds the keys
    time.sleep(1.5)
    p.win.type_keys("zz")
    screen = p.win.screen()
    rows = pane_rows(screen)
    p.check("after the dialog the keys reach the field", rows is not None and "zz" in rows[3] and not prompt_text(screen).endswith("zz"), f"field {rows[3] if rows else None!r} prompt {prompt_text(screen)!r}")
    p.wait_for(lambda s: "Claude is done" in "".join((pane_rows(s) or [""])[3:]), timeout=40)
    close_test(p)


def case_weak_pairs(p: Probe) -> None:
    print("the weak pair from the store shows before the first key")
    ensure_ready(p)
    p.check("the ready row names the weak pair", "your weak pairs: th" in pane_status(p), pane_status(p))


def case_toolbar_leak(p: Probe) -> None:
    print("a letter typed with the ring on the toolbar starts the test, not the prompt")
    ensure_ready(p)
    p.win.send(TAB)
    time.sleep(0.4)
    word = p.current()
    p.win.type_keys(word[0])
    time.sleep(0.6)
    screen = p.win.screen()
    rows = pane_rows(screen)
    p.check("the prompt stays empty", prompt_text(screen) == "", prompt_text(screen))
    p.check("the field holds the letter and has the keys", rows is not None and rows[3].lstrip().startswith(word[0]) and "⏎ finish" in rows[3], str(rows))
    p.commit(word[1:])
    p.check("the word goes on in the field: 1 word", count_of(p.status()) == "1", p.status())


def case_card_leak_and_details(p: Probe) -> None:
    print("on the card: a letter on a Button stays out of the prompt; details over two rows")
    p.enter()
    time.sleep(1.3)
    p.win.send(TAB)  # the ring from the card's field to close
    time.sleep(0.4)
    p.win.type_keys("q")
    time.sleep(0.5)
    p.check("a letter on a card Button stays out of the prompt", prompt_text(p.win.screen()) == "", prompt_text(p.win.screen()))
    rows = p.pane(0)
    p.check("the card is still there, five rows", rows is not None and len(rows) == 5 and re.match(r"\d+ wpm", rows[0].strip()) is not None, str(rows))
    before = rows[1].lstrip().startswith("raw ") if rows else False
    p.win.send("d")
    rows = p.pane()
    shown = rows is not None and rows[1].lstrip().startswith("raw ")
    p.check("d toggles the details", shown != before, str(rows))
    if not shown:
        p.win.send("d")
        rows = p.pane()
    p.check("the details over two rows, none cut at 100 columns", rows is not None and rows[1].lstrip().startswith("raw ") and rows[2].lstrip().startswith("correct ") and "…" not in rows[1] + rows[2], str(rows))
    p.shot("details")
    p.win.resize(44)
    rows = p.pane(1.2)
    p.check("44 columns: the card keeps five rows", rows is not None and len(rows) == 5, str(rows))
    p.shot("card-44")
    p.win.resize(COLUMNS)
    time.sleep(1)
    p.win.send("d")
    again(p)


def case_word_list(p: Probe) -> None:
    print("another word list, picked by keyboard")
    ensure_ready(p)
    # The list's button, its options in name order without the one in use: english first.
    p.win.send(TAB)
    time.sleep(0.3)
    p.enter()
    time.sleep(0.5)
    rows = p.pane(0)
    p.check("the list's options show", rows is not None and "english_5k" in rows[4] and "english_10k" in rows[4], rows[4] if rows else "")
    p.win.send(TAB)
    time.sleep(0.3)
    p.enter()
    rows = p.pane(0.8)
    p.check("english in use, the options closed", rows is not None and rows[4].lstrip().startswith("◍ english ") and "english_5k" not in rows[4], rows[4] if rows else "")
    p.check("the field has the keys after the pick", rows is not None and "start typing ⏎ finish" in rows[3], rows[3] if rows else "")
    p.new_test()
    p.type_words(2)
    p.check("words of the new list type as usual", count_of(p.status()) == "2", p.status())
    p.enter()
    again(p)


def case_other_counts(p: Probe) -> None:
    print("time 60 and words 25: the clock and the count; Enter ends early")
    ensure_ready(p)
    pick(p, 3, 3)  # time: 15 30 60 120, the third
    rows = p.pane()
    p.check("time 60 in use", rows is not None and "◷ time (60)" in rows[4], rows[4] if rows else "")
    p.type_words(1)
    p.check("the clock counts down from 1:00", re.search(r"0:5\d left", p.status()) is not None, p.status())
    p.enter()
    rows = p.pane(1.0)
    p.check("Enter ends it early: no personal best try", rows is not None and "ended early" in rows[0], str(rows))
    again(p)
    pick(p, 4, 2)  # words: 10 25 50 100, the second
    p.type_words(2)
    p.check("words 25 counts 2/25", "2/25" in p.status(), p.status())
    p.enter()
    again(p)


def case_esc_on_card(p: Probe) -> None:
    print("Esc on the result card: the card goes, nothing waits")
    ensure_ready(p)
    p.type_words(1)
    p.enter()
    time.sleep(1.3)
    p.win.send(ESC)
    time.sleep(0.8)
    screen = p.win.screen()
    p.check("Esc hides the card", pane_rows(screen) is None, "a pane still shows")
    p.check("no band offers anything", band_line(screen) == "", band_line(screen))


def case_clear_mid_test(p: Probe) -> None:
    print("/clear in the middle of a test")
    ensure_ready(p)
    p.type_words(1)
    p.win.send(ESC)
    time.sleep(0.6)
    p.win.send("/clear")
    time.sleep(0.6)
    p.enter("/clear")
    time.sleep(2.5)
    screen = p.win.screen()
    p.check("after /clear no pane and no band", pane_rows(screen) is None and band_line(screen) == "", band_line(screen))
    open_game(p)
    rows = p.pane(1.2)
    p.check("/type opens a fresh test after /clear", rows is not None and "start typing" in rows[3], str(rows))


# ─── Run ─────────────────────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--turns", action="store_true")
    parser.add_argument("--shots", type=Path, default=None)
    parser.add_argument("--only", nargs="*", default=None, help="run these cases alone, by name without case_")
    args = parser.parse_args()
    shots = args.shots or Path(tempfile.mkdtemp(prefix="turntype-shots-"))
    shots.mkdir(parents=True, exist_ok=True)

    backup = Path(tempfile.mkdtemp(prefix="turntype-store-"))
    stores = list(STORE_DIR.glob("turntype_*.json"))
    for store in stores:
        shutil.copy2(store, backup / store.name)
        store.write_text(json.dumps(CLEAN_STORE))

    win = Window()
    p = Probe(win, shots)
    try:
        win.send(f"cd {REPO} && claude --plugin-dir .")
        win.send(ENTER)
        if not p.wait_for(lambda s: any(line.startswith("❯") for line in s), timeout=30):
            print("Claude Code did not start")
            return 2
        time.sleep(2)
        cases = [
            case_open_and_ready,
            case_mode_in_use_back_to_field,
            case_first_key_focus,
            case_typo_and_backspace,
            case_spaces_and_backspace_into_word,
            case_line_moves_up,
            case_idle_pause,
            case_esc_and_back,
            case_one_with_text_in_prompt,
            case_flow_enter_and_card,
            case_words_test,
            case_time_runs_out,
            case_keys_after_the_end,
            case_paste,
            case_widths,
            case_weak_pairs,
            case_toolbar_leak,
            case_card_leak_and_details,
            case_word_list,
            case_other_counts,
            case_esc_on_card,
            case_clear_mid_test,
            case_close,
        ]
        if args.turns:
            cases += [case_turn_claude_done, case_permission_dialog]
        if args.only:
            cases = [case for case in cases if case.__name__.removeprefix("case_") in args.only]
        for case in cases:
            try:
                case(p)
            except Exception as error:  # one broken case must not stop the rest
                p.check(f"{case.__name__} ran", False, repr(error))
    finally:
        try:
            win.send(ESC)
            time.sleep(0.4)
            for _ in range(len(prompt_text(win.screen())) + 2):
                win.send(BS)
            win.send("/exit")
            time.sleep(0.6)
            if prompt_text(win.screen()) == "/exit":
                win.send(ENTER)
                time.sleep(2)
        finally:
            win.close()
            for store in STORE_DIR.glob("turntype_*.json"):
                if not (backup / store.name).exists():
                    store.unlink()
            for saved in backup.iterdir():
                shutil.copy2(saved, STORE_DIR / saved.name)

    failed = [r for r in p.results if not r[1]]
    print(f"\n{len(p.results) - len(failed)} passed, {len(failed)} failed. Screenshots: {shots}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
