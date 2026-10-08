# turntype

A typing test for the time while Claude works. A Claude Code mod.

When a turn takes more than 3 seconds, a line shows above the prompt: `press 1: type while you wait`. Press `1` in an empty prompt (or run `/type`) to open the game. Type the words. Your result, personal best and daily total show when the test ends.

Beside the invitation, a dim note keeps today in view: `press 1: type while you wait ⋅ 2/5 min today ⋅ 4-day streak`. Before your first test of the day it reads `keep your 4-day streak`; with the goal met, `daily goal met (5 min)`. Any day with a test keeps the streak. Set the goal in `/config` under **Daily goal (minutes)** (3 to 30, default 5), or `off` for the streak alone. A toast marks a new personal best and each milestone the first time you reach it: 40 to 100 wpm by tens, then 120 and 150, and 3, 7, 30 and 100-day streaks.

Tested with **Claude Code 2.1.292**. The mods API can change between releases.

## Modes

| Mode | The test ends when |
| --- | --- |
| `flow` (default) | Claude is done and you complete the word, or you press Enter |
| `words` 10 / 25 / 50 / 100 | You type the last word |
| `time` 15 / 30 / 60 / 120 | The active time runs out (a pause of more than 2 s does not count) |

Pick a mode in the toolbar under the field before the first key (`◍ english_1k ❘ ∿ flow  ◷ time (30)  ☰ words (25)`, the ones in use bright): press **Tab** to reach it, then Enter, or click. A press on the list, time or words shows its options (`◷ time  15  30  60  120`); a pick closes them and the field takes the keys again. Picks are saved for the next session. With **adaptive words** on (the default; turn it off in `/config`), about a third of the words practice the letter pairs you miss most.

## Word lists

The words come from JSON files in `word-lists/`: `english` (200 common words), `english_1k`, `english_5k` and `english_10k` (the 1,000, 5,000 and about 10,000 most common words, from [Monkeytype](https://github.com/monkeytypegame/monkeytype)). `english_1k` is the default. To change the list, open it in the toolbar before you start typing (`◍ english_1k`): every list shows by its file name.

To add a list, add a file such as `word-lists/german.json`:

```json
{ "words": ["und", "der", "die", "das", "..."] }
```

- The file name is the list's name: lowercase letters, digits, underscores and dashes (`english_1k`).
- A list needs at least 20 words. A word has no spaces and at most 24 characters. Repeats are removed.
- A file that is not valid shows in the toolbar until you pick it: the pick then says so, keeps the list in use, and the file leaves the toolbar. An unknown name uses `english`.
- Personal bests are kept per list, so `english_10k` never competes with `english`.

The list names are read when the session starts and when the mod reloads. A list's words are read the first time it is used, then kept.

## Keys

| Key | Where | What it does |
| --- | --- | --- |
| `1` | Empty prompt | Opens the game, continues a test, or goes back to the game after a dialog took the keys |
| `ctrl+x tab` | Anywhere | Gives the keys back to the game pane |
| Enter | Game field | Ends the test |
| Tab | Game field, before the first key | Moves to the toolbar: word lists, modes and counts |
| Esc | Game pane | Hides the pane. A test in progress waits in the band. |
| `a` / `x` / `d` | Result card | Again / close / show or hide details |

## Install

From a marketplace that lists the mod:

```text
/plugin install turntype@<marketplace>
/reload-plugins
```

To load the folder for one session: `claude --plugin-dir <path to turntype>`.

## Data

Results are kept in the mod's own store (`~/.claude/plugins/store/`): your picks (word list, mode, counts), personal bests per test, the last 200 fair results, daily totals for 400 days, and the letter-pair statistics. Nothing is sent anywhere.

## Develop

```shell
claude plugin validate --strict .   # manifest, hooks and calls
claude plugin test .                # engine, flow, probe and cost tests
tsc -p .                            # types (written by Claude Code into .claude-plugin/types/)
```

`tests/probe.test.ts` covers the flow and its edge cases. `tests/cost.test.ts` holds the hot paths to zero extra redraws and host calls. Check these by hand, because the test kit cannot press Esc or move `Date.now()`: Esc during a test, and a time test that runs out.

## License

turntype is free software under the [GNU General Public License v3.0 or later](LICENSE).

The word lists `english_1k`, `english_5k` and `english_10k` are copied unchanged from [Monkeytype](https://github.com/monkeytypegame/monkeytype) (`frontend/static/languages/`), © the Monkeytype contributors, licensed under GPL-3.0. The list `english` is our own.
