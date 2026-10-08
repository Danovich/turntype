import { describe, expect, test } from 'claude-code/testing'

import type { TypingRound, TypingRoundFinished, TypingRoundReady, TypingRoundRunning } from '../types'
import { applyProgressChanges, dayStanding, EMPTY_PROGRESS, milestonesReached, parseLegacyProgress, progressChanges, recordResult, sparkline, todayPractice, weakBigrams } from '../hooks/engine/progress'
import { FALLBACK_WORD_LIST, parseWordList, pickWords, wordListOrder } from '../hooks/engine/word-list'
import { applyFieldInput, createRound, expireRound, finishByPlayer, finishRound, ROUND_ENDING } from '../hooks/engine/round'
import { DEFAULT_SETTINGS, parseDailyGoalMinutes, parseSavedPicks, parseTypingSettings, settingsInUse } from '../hooks/engine/settings'
import { COUNTED_MODES, MODES } from '../hooks/engine/modes'
import { calculateResult, kogasa, liveWpm } from '../hooks/engine/stats'
import { activeElapsedMs, isIdle } from '../hooks/engine/timing'
import { parseTyped } from '../hooks/engine/typed-text'
import { buildVisibleLines, LETTER_STYLE } from '../hooks/engine/layout'
import { bandKind, keepsRound, roundAfter } from '../hooks/engine/lifecycle'
import { bigNumberRows } from '../hooks/engine/big-digits'
import { resultToast } from '../hooks/view/shared'
import { EMPTY_FOLD, foldWindow } from '../hooks/engine/window'
import { scoreWord, totalSamples } from '../hooks/engine/stats'

const READY: TypingRoundReady = {
  roundId: 1,
  mode: 'flow',
  count: undefined,
  phase: 'ready',
  targetWords: ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog'],
  isClaudeDone: false,
  fieldIndex: 0,
  fieldBaseLength: 0,
  fieldValue: '',
  focusBigrams: [],
  pbWpm: undefined,
  wordList: 'english',
}

/** Two words with "ck" among 52, as in real English: practice can find them, chance rarely does. */
const ENGLISH_SAMPLE = [...FALLBACK_WORD_LIST.words, 'quick', 'black']

const asRunning = (round: ReturnType<typeof applyFieldInput>): TypingRoundRunning => {
  if (round.phase !== 'running') {
    throw new Error(`expected a running round, got ${round.phase}`)
  }

  return round
}

/**
 * Types `text` one character at a time, `intervalMs` apart from `startMs`, into the field the
 * round says is current: a key every change, as a real player sends them.
 */
const typeEvenly = (
  round: TypingRoundReady | TypingRoundRunning,
  text: string,
  startMs: number,
  intervalMs: number,
): ReturnType<typeof applyFieldInput> =>
  [...text].reduce<ReturnType<typeof applyFieldInput>>((current, _, index) => {
    if (current.phase === 'finished') {
      return current
    }
    const typed = (current.phase === 'running' ? current.typed : '') + text[index]

    return applyFieldInput(current, current.fieldIndex, current.fieldBaseLength, typed.slice(current.fieldBaseLength), startMs + index * intervalMs)
  }, round)

describe('engine', () => {
  test('spaces before a word open a fresh field: the round and the typed text do not change', async () => {
    const afterSpace = applyFieldInput(READY, 0, 0, '  ', 0)
    expect(afterSpace).toEqual({ ...READY, fieldIndex: 1 })

    const running = asRunning(applyFieldInput(READY, 0, 0, 'the ', 0))
    const afterExtraSpace = asRunning(applyFieldInput(running, running.fieldIndex, running.fieldBaseLength, ' ', 100))
    expect(afterExtraSpace.typed).toBe('the ')
    expect(afterExtraSpace.fieldIndex).toBe(running.fieldIndex + 1)
    expect(afterExtraSpace.correctKeystrokes).toBe(running.correctKeystrokes)
  })

  test('keys past a word\'s end are discarded: not typed, not scored, and a fresh field holds the word', async () => {
    const full = asRunning(typeEvenly(READY, 'the', 0, 100))
    expect(full.correctKeystrokes).toBe(3)
    expect(full.fieldValue).toBe('')

    // A fourth letter: not typed, not scored; the field (it shows the letter) is replaced by one holding "the".
    const cut = asRunning(applyFieldInput(full, full.fieldIndex, full.fieldBaseLength, 'thex', 400))
    expect(cut.typed).toBe('the')
    expect(cut.correctKeystrokes).toBe(3)
    expect(cut.incorrectKeystrokes).toBe(0)
    expect(cut.fieldIndex).toBe(full.fieldIndex + 1)
    expect(cut.fieldValue).toBe('the')

    // A late key in the replaced field is not taken: the new field already holds text.
    expect(applyFieldInput(cut, full.fieldIndex, full.fieldBaseLength, 'thexy', 450)).toBe(cut)

    // In the new field a backspace edits as usual, and the field keeps its starting text.
    const edited = asRunning(applyFieldInput(cut, cut.fieldIndex, cut.fieldBaseLength, 'th', 500))
    expect(edited.typed).toBe('th')
    expect(edited.fieldIndex).toBe(cut.fieldIndex)
    expect(edited.fieldValue).toBe('the')

    // Typed out again, a space commits the word as correct, and the next field starts empty.
    const committed = asRunning(applyFieldInput(edited, edited.fieldIndex, edited.fieldBaseLength, 'the ', 600))
    expect(committed.typed).toBe('the ')
    expect(committed.fieldValue).toBe('')
    expect(parseTyped(committed.typed).committedWords).toEqual(['the'])
  })

  test('a space opens a fresh field whose base is the committed text', async () => {
    const round = asRunning(applyFieldInput(READY, 0, 0, 'the ', 1000))

    expect(round.fieldIndex).toBe(1)
    expect(round.typed.slice(0, round.fieldBaseLength)).toBe('the ')
    expect(round.correctKeystrokes).toBe(4)
  })

  test('fast typing across a space: a late key in the old field is kept, then the new field continues', async () => {
    const afterSpace = asRunning(applyFieldInput(READY, 0, 0, 'the ', 1000))
    // The "q" landed in field 0 before the redraw replaced it with field 1.
    const lateKey = asRunning(applyFieldInput(afterSpace, 0, 0, 'the q', 1050))

    expect(lateKey.typed).toBe('the q')
    expect(lateKey.fieldIndex).toBe(1)
    expect(lateKey.typed.slice(0, lateKey.fieldBaseLength)).toBe('the q')

    // Field 1 started empty and holds only what came after the late key.
    const continued = asRunning(applyFieldInput(lateKey, 1, lateKey.fieldBaseLength, 'uick ', 1300))

    expect(continued.typed).toBe('the quick ')
    expect(continued.fieldIndex).toBe(2)
    expect(continued.incorrectKeystrokes).toBe(0)
  })

  test('a late key from an old field is dropped once the new field has text', async () => {
    const afterSpace = asRunning(applyFieldInput(READY, 0, 0, 'the ', 1000))
    const newField = asRunning(applyFieldInput(afterSpace, 1, 4, 'q', 1100))
    const stale = applyFieldInput(newField, 0, 0, 'the x', 1150)

    expect(stale).toBe(newField)
  })

  test('accuracy counts a typo even after it is fixed', async () => {
    const typo = asRunning(applyFieldInput(READY, 0, 0, 'tg', 1000))
    const fixed = asRunning(applyFieldInput(typo, 0, 0, 't', 1100))
    const done = asRunning(applyFieldInput(fixed, 0, 0, 'the ', 1500))
    const { result } = finishRound(done, ROUND_ENDING.complete)

    // t✓ g✗ (backspace is not a keystroke) h✓ e✓ space✓ → 4 of 5.
    expect(done.incorrectKeystrokes).toBe(1)
    expect(result.accuracy).toBe(80)
    expect(result.chars.incorrect).toBe(0)
  })

  test('wpm counts correct words with their spaces: "the quick " is 10 chars, in 6 s that is 20 wpm', async () => {
    // 10 keys, the first at 0 and the last at 6 s.
    const typed = asRunning(typeEvenly(READY, 'the quick ', 0, 6000 / 9))
    const { result } = finishRound(typed, ROUND_ENDING.complete)

    expect(result.wpm).toBe(20)
  })

  test('kogasa: an even pace is 100, a jagged pace is lower', async () => {
    expect(kogasa(0)).toBe(100)
    expect(kogasa(0.5)).toBeLessThan(60)
  })

  test('pause: of a 60 s gap only 3 s count, so the break leaves wpm and the samples alone', async () => {
    const started = asRunning(applyFieldInput(READY, 0, 0, 't', 0))
    const beforeBreak = asRunning(applyFieldInput(started, 0, 0, 'the ', 3000))
    const afterBreak = asRunning(applyFieldInput(beforeBreak, 1, 4, 'quick ', 66_000))

    expect(afterBreak.pausedMs).toBe(60_000)
    // Active time is 6 s, so the samples span 7 active seconds, not 67 wall seconds.
    expect(activeElapsedMs(afterBreak, 66_000)).toBe(6000)
    expect(afterBreak.keystrokesPerSecond).toHaveLength(7)
    expect(finishRound(afterBreak, ROUND_ENDING.complete).result.wpm).toBe(20)
  })

  test('the clock stops while idle', async () => {
    const started = asRunning(applyFieldInput(READY, 0, 0, 't', 1000))

    expect(isIdle(started, 3500)).toBe(false)
    expect(isIdle(started, 4500)).toBe(true)
    expect(activeElapsedMs(started, 10_000)).toBe(3000)
  })

  test('time mode: ends at the limit of active time, measured over exactly the limit', async () => {
    const timed: TypingRoundReady = { ...READY, mode: 'time', count: 15 }
    // 6 keys, 2.8 s apart (under the idle limit): the last one lands at 14 s of active time.
    const nearEnd = asRunning(typeEvenly(timed, 'the qu', 0, 2800))

    expect(activeElapsedMs(nearEnd, 14_000)).toBe(14_000)
    expect(expireRound(nearEnd, 14_500).phase).toBe('running')
    const expired = expireRound(nearEnd, 15_500)
    expect(expired.phase).toBe('finished')
    if (expired.phase === 'finished') {
      expect(expired.result.durationMs).toBe(15_000)
      // "the " plus the correct prefix "qu": 6 chars in 15 s is 5 wpm (rounded from 4.8).
      expect(expired.result.wpm).toBe(5)
    }
    // A key that arrives after the time is up ends the test without counting.
    expect(applyFieldInput(nearEnd, nearEnd.fieldIndex, nearEnd.fieldBaseLength, 'qui', 15_800).phase).toBe('finished')
  })

  test('time mode ended early with Enter: measured over the active time, not the limit', async () => {
    const timed: TypingRoundReady = { ...READY, mode: 'time', count: 30 }
    const typed = asRunning(typeEvenly(timed, 'the quick ', 0, 6000 / 9))
    const ended = finishByPlayer(typed)

    expect(ended.ending).toBe('early')
    expect(ended.result.durationMs).toBe(6000)
    expect(ended.result.wpm).toBe(20)
  })

  test('live wpm reads the running counter; a deletion that removes a space counts again', async () => {
    const typed = asRunning(applyFieldInput(READY, 0, 0, 'the quick ', 0))

    expect(typed.correctWordCharacters).toBe(10)
    expect(liveWpm(typed, 6000)).toBe(20)

    const withoutSpace = asRunning(applyFieldInput(typed, 0, 0, 'the quick', 1000))
    expect(withoutSpace.correctWordCharacters).toBe(4)
  })

  test('settings: the defaults come from the mode table; /config gives adaptive alone', async () => {
    expect(DEFAULT_SETTINGS).toEqual({ mode: 'flow', counts: { time: 30, words: 25 }, isAdaptive: true, wordList: 'english' })
    expect(parseTypingSettings({ adaptive: 'off' })).toEqual({ ...DEFAULT_SETTINGS, isAdaptive: false })
    // The rows /config no longer has are left alone, whatever an old settings file holds.
    expect(parseTypingSettings({ mode: 'time', wordList: 'code' })).toEqual(DEFAULT_SETTINGS)
  })

  test('saved picks: read back over the defaults; the shape before counts per mode is read too', async () => {
    expect(parseSavedPicks(undefined, DEFAULT_SETTINGS)).toBeNull()
    expect(parseSavedPicks({ mode: 'time', counts: { time: 60, words: 50 }, wordList: 'code' }, DEFAULT_SETTINGS)).toEqual({
      mode: 'time',
      counts: { time: 60, words: 50 },
      wordList: 'code',
    })
    expect(parseSavedPicks({ mode: 'words', wordCount: 10, timeSeconds: 15, wordList: 'english_1k' }, DEFAULT_SETTINGS)).toEqual({
      mode: 'words',
      counts: { time: 15, words: 10 },
      wordList: 'english_1k',
    })
    // An odd field keeps its default; a name that cannot be a file name too.
    expect(parseSavedPicks({ mode: 'zen', counts: { time: 'many' }, wordList: '../secrets' }, DEFAULT_SETTINGS)).toEqual({
      mode: 'flow',
      counts: { time: 30, words: 25 },
      wordList: 'english',
    })
  })

  test('the mode table: every count belongs to one mode, and each default is one of its counts', async () => {
    const presets = COUNTED_MODES.flatMap(mode => [...MODES[mode].count.presets])
    expect(new Set(presets).size).toBe(presets.length)
    expect(COUNTED_MODES.every(mode => MODES[mode].count.presets.includes(MODES[mode].count.default))).toBe(true)
  })
})

// Noon, so a day boundary in any time zone stays far away.
const DAY_ONE_NOON = new Date(2026, 9, 5, 12).getTime()
const DAY_MS = 86_400_000

const finished = (overrides: Partial<TypingRoundFinished['result']>, round: Partial<TypingRoundFinished> = {}): TypingRoundFinished => ({
  ...READY,
  mode: 'time',
  count: 30,
  phase: 'finished',
  typed: '',
  ending: 'timeUp',
  bigramErrors: {},
  hasPastedText: false,
  fold: EMPTY_FOLD,
  progress: undefined,
  result: {
    wpm: 60,
    raw: 62,
    accuracy: 96,
    consistency: 80,
    chars: { correct: 150, incorrect: 2, extra: 0, missed: 0 },
    durationMs: 30_000,
    wordCount: 30,
    ...overrides,
  },
  ...round,
})

describe('paste guard', () => {
  test('a change that adds more than a burst of keys marks the test as pasted; key by key does not', async () => {
    expect(asRunning(applyFieldInput(READY, 0, 0, 'the', 0)).hasPastedText).toBe(false)
    expect(asRunning(applyFieldInput(READY, 0, 0, 'the ', 0)).hasPastedText).toBe(true)
    expect(asRunning(typeEvenly(READY, 'the quick brown ', 0, 100)).hasPastedText).toBe(false)

    const pasted = asRunning(applyFieldInput(READY, 0, 0, 'the ', 0))
    expect(finishByPlayer(pasted).hasPastedText).toBe(true)
  })

  test('a pasted test can never be a personal best, but counts for today', async () => {
    const recorded = recordResult(EMPTY_PROGRESS, finished({ wpm: 900 }, { hasPastedText: true }), DAY_ONE_NOON)

    expect(recorded.summary.pb).toEqual({ kind: 'unfair', reason: 'text was pasted', pbWpm: undefined })
    expect(recorded.progress.personalBests).toEqual({})
    expect(recorded.summary.todayTests).toBe(1)
  })
})

describe('progress', () => {
  test('two sessions save at once: each merges into what the other saved, so both tests stay', async () => {
    const base = recordResult(EMPTY_PROGRESS, finished({ wpm: 60 }), DAY_ONE_NOON).progress
    const thisSession = progressChanges(finished({ wpm: 70 }), DAY_ONE_NOON + 1000)
    const otherSession = progressChanges(finished({ wpm: 80 }, { count: 15 }), DAY_ONE_NOON + 2000)

    // The other session saved first; this one merges into that, not into the copy it read.
    const saved = applyProgressChanges(applyProgressChanges(base, otherSession), thisSession)
    expect(saved.personalBests).toMatchObject({ 'time:30:english': { wpm: 70 }, 'time:15:english': { wpm: 80 } })
    expect(saved.history.map(entry => entry.wpm)).toEqual([60, 80, 70])
    expect(Object.values(saved.daily)).toMatchObject([{ tests: 3 }])
  })

  test('a merge keeps the higher personal best, and a result saved twice is added once', async () => {
    const changes = progressChanges(finished({ wpm: 70 }), DAY_ONE_NOON)
    const higherElsewhere = recordResult(EMPTY_PROGRESS, finished({ wpm: 95 }), DAY_ONE_NOON - 1000).progress

    expect(applyProgressChanges(higherElsewhere, changes).personalBests['time:30:english']?.wpm).toBe(95)
    expect(changes.history(changes.history([])).length).toBe(1)
  })

  test('the record of versions before 0.8 splits into its parts; another version is empty', async () => {
    const legacy = { version: 1, personalBests: { 'flow:english': { wpm: 50, accuracy: 90, at: 1 } }, history: [], daily: {}, bigrams: {} }

    expect(parseLegacyProgress(legacy).personalBests).toEqual(legacy.personalBests)
    expect(parseLegacyProgress({ ...legacy, version: 2 })).toEqual(EMPTY_PROGRESS)
  })

  test('the first fair result is the first pb; a faster one is a new pb, a slower one keeps it', async () => {
    const first = recordResult(EMPTY_PROGRESS, finished({ wpm: 60 }), DAY_ONE_NOON)
    expect(first.summary.pb).toEqual({ kind: 'first' })
    expect(first.summary.trendDelta).toBeUndefined()

    const faster = recordResult(first.progress, finished({ wpm: 70 }), DAY_ONE_NOON + 60_000)
    expect(faster.summary.pb).toEqual({ kind: 'new', previousWpm: 60 })
    expect(faster.summary.trendDelta).toBe(10)

    const slower = recordResult(faster.progress, finished({ wpm: 50 }), DAY_ONE_NOON + 120_000)
    expect(slower.summary.pb).toEqual({ kind: 'kept', pbWpm: 70 })
    // 50 against the average of 60 and 70.
    expect(slower.summary.trendDelta).toBe(-15)
    expect(slower.summary.recentWpm).toEqual([60, 70, 50])
    expect(slower.summary.todayTests).toBe(3)
    expect(slower.summary.todayActiveMs).toBe(90_000)
  })

  test('each configuration has its own pb', async () => {
    const timeThirty = recordResult(EMPTY_PROGRESS, finished({ wpm: 90 }), DAY_ONE_NOON)
    const timeFifteen = recordResult(timeThirty.progress, finished({ wpm: 60 }, { count: 15 }), DAY_ONE_NOON)

    expect(timeFifteen.summary.pb).toEqual({ kind: 'first' })
  })

  test('unfair results set no pb and stay out of the history, but count for today', async () => {
    const fair = recordResult(EMPTY_PROGRESS, finished({ wpm: 60 }), DAY_ONE_NOON)
    const early = recordResult(fair.progress, finished({ wpm: 120 }, { ending: 'early' }), DAY_ONE_NOON)
    const sloppy = recordResult(early.progress, finished({ wpm: 120, accuracy: 70 }), DAY_ONE_NOON)
    const shortFlow = recordResult(sloppy.progress, finished({ wpm: 120, durationMs: 8000 }, { mode: 'flow', ending: 'complete' }), DAY_ONE_NOON)

    expect(early.summary.pb).toEqual({ kind: 'unfair', reason: 'ended early', pbWpm: 60 })
    expect(sloppy.summary.pb).toEqual({ kind: 'unfair', reason: 'accuracy under 75%', pbWpm: 60 })
    expect(shortFlow.summary.pb).toEqual({ kind: 'unfair', reason: 'under 15 s', pbWpm: undefined })
    expect(shortFlow.progress.history).toHaveLength(1)
    expect(shortFlow.summary.todayTests).toBe(4)
  })

  test('the 7-day trend leaves out older results; the streak counts days in a row', async () => {
    const old = recordResult(EMPTY_PROGRESS, finished({ wpm: 30 }), DAY_ONE_NOON - 10 * DAY_MS)
    const yesterday = recordResult(old.progress, finished({ wpm: 50 }), DAY_ONE_NOON - DAY_MS)
    const today = recordResult(yesterday.progress, finished({ wpm: 56 }), DAY_ONE_NOON)

    expect(today.summary.trendDelta).toBe(6)
    expect(today.summary.streakDays).toBe(2)
    expect(today.summary.todayTests).toBe(1)
  })

  test('today: the streak counts today once played, and until then the run that ended yesterday', async () => {
    const twoDays = recordResult(recordResult(EMPTY_PROGRESS, finished({}), DAY_ONE_NOON - 2 * DAY_MS).progress, finished({}), DAY_ONE_NOON - DAY_MS)
    const notYet = dayStanding(twoDays.progress.daily, DAY_ONE_NOON)
    const played = recordResult(twoDays.progress, finished({ durationMs: 90_000 }), DAY_ONE_NOON)

    expect(todayPractice(notYet, DAY_ONE_NOON)).toEqual({ activeMs: 0, streakDays: 2, isPlayedToday: false })
    expect(todayPractice(dayStanding(played.progress.daily, DAY_ONE_NOON), DAY_ONE_NOON)).toEqual({
      activeMs: 90_000,
      streakDays: 3,
      isPlayedToday: true,
    })
    expect(played.summary.streakDays).toBe(3)
  })

  test('today past midnight: a standing from yesterday keeps its streak alive; an older one has none', async () => {
    const yesterday = recordResult(EMPTY_PROGRESS, finished({}), DAY_ONE_NOON - DAY_MS)
    const standing = dayStanding(yesterday.progress.daily, DAY_ONE_NOON - DAY_MS)

    expect(todayPractice(standing, DAY_ONE_NOON)).toEqual({ activeMs: 0, streakDays: 1, isPlayedToday: false })
    expect(todayPractice(standing, DAY_ONE_NOON + DAY_MS)).toEqual({ activeMs: 0, streakDays: 0, isPlayedToday: false })
  })

  test('milestones: the highest new speed once, a streak length once, nothing for an unfair test', async () => {
    const first = recordResult(EMPTY_PROGRESS, finished({ wpm: 45 }), DAY_ONE_NOON - 2 * DAY_MS)
    const faster = recordResult(first.progress, finished({ wpm: 72 }), DAY_ONE_NOON - DAY_MS)
    const again = recordResult(faster.progress, finished({ wpm: 75 }), DAY_ONE_NOON - DAY_MS)
    const third = recordResult(again.progress, finished({ wpm: 101 }, { ending: 'early' }), DAY_ONE_NOON)

    expect(milestonesReached(EMPTY_PROGRESS, first.progress, DAY_ONE_NOON - 2 * DAY_MS)).toEqual(['first 40 wpm test'])
    expect(milestonesReached(first.progress, faster.progress, DAY_ONE_NOON - DAY_MS)).toEqual(['first 70 wpm test'])
    expect(milestonesReached(faster.progress, again.progress, DAY_ONE_NOON - DAY_MS)).toEqual([])
    // Ended early: no speed milestone, but the day counts for the streak.
    expect(milestonesReached(again.progress, third.progress, DAY_ONE_NOON)).toEqual(['3-day streak'])
  })

  test('the result toast: a new best and the milestones in one, or none', async () => {
    const round = finished({ wpm: 61 })
    const summary = recordResult(EMPTY_PROGRESS, round, DAY_ONE_NOON).summary
    const newBest = { ...summary, pb: { kind: 'new', previousWpm: 58 } } as const

    expect(resultToast(round, newBest, ['first 60 wpm test'])).toBe('✦ new personal best: 61 wpm ⋅ time 30 ⋅ first 60 wpm test')
    expect(resultToast(round, summary, ['7-day streak'])).toBe('✦ 7-day streak')
    expect(resultToast(round, summary, [])).toBeUndefined()
  })

  test('a picked list whose file is gone: the default list is in use, the other picks stay', async () => {
    const picks = { mode: 'time', counts: DEFAULT_SETTINGS.counts, wordList: 'code' } as const

    expect(settingsInUse(DEFAULT_SETTINGS, picks, name => name === 'code')).toMatchObject({ mode: 'time', wordList: 'code' })
    expect(settingsInUse(DEFAULT_SETTINGS, picks, name => name === 'english')).toMatchObject({ mode: 'time', wordList: 'english' })
  })

  test('the daily goal from /config: minutes, or off', async () => {
    expect(parseDailyGoalMinutes({ dailyGoal: '5' })).toBe(5)
    expect(parseDailyGoalMinutes({ dailyGoal: 'off' })).toBeUndefined()
    expect(parseDailyGoalMinutes({})).toBeUndefined()
  })

  test('sparkline: lowest to highest; a flat run sits in the middle', async () => {
    expect(sparkline([10, 20, 30])).toBe('▁▅█')
    expect(sparkline([40, 40])).toBe('▄▄')
  })
})

describe('adaptive words', () => {
  test('a wrong key records the letter pair the player meant; a first letter has no pair', async () => {
    // "tge": "g" for the "h" of "th"; then "x" for the "t" of "quick" has no pair before it.
    const typed = asRunning(applyFieldInput(READY, 0, 0, 'tge x', 1000))

    expect(typed.bigramErrors).toEqual({ th: 1 })
    expect(finishRound(typed, ROUND_ENDING.complete).bigramErrors).toEqual({ th: 1 })
  })

  test('after a slip the next wrong keys of the word blame no pair, until the word is back on track', async () => {
    // "qxxxx" for "quick": only the first "x" missed a pair ("qu"); the others are out of place.
    const slipped = asRunning(typeEvenly(READY, 'the qxxxx', 0, 100))
    expect(slipped.bigramErrors).toEqual({ qu: 1 })

    // Back to "q" with backspace, then "i" for the "u" again: on track, so it counts.
    const corrected = asRunning(applyFieldInput(slipped, slipped.fieldIndex, slipped.fieldBaseLength, 'q', 2000))
    const slippedAgain = asRunning(applyFieldInput(corrected, corrected.fieldIndex, corrected.fieldBaseLength, 'qi', 2100))
    expect(slippedAgain.bigramErrors).toEqual({ qu: 2 })
  })

  test('a pair missed often enough becomes a weak pair; old misses fade', async () => {
    // "the" three times a test, 20 tests, "th" missed in every second test. The fade (×0.9 a test)
    // means a pair needs a few tries per test to count: one slip in a rare pair never does.
    const practiceRound = (index: number) =>
      finished(
        { wordCount: 3 },
        { typed: 'the the the', targetWords: ['the', 'the', 'the'], bigramErrors: index % 2 === 0 ? { th: 1 } : {} },
      )
    const practiced = Array.from({ length: 20 }, (_, index) => index).reduce(
      (progress, index) => recordResult(progress, practiceRound(index), DAY_ONE_NOON + index).progress,
      EMPTY_PROGRESS,
    )

    expect(weakBigrams(practiced)).toEqual(['th'])

    // Twenty clean runs later the old misses weigh too little to count.
    const cleanRound = finished({ wordCount: 3 }, { typed: 'the the the', targetWords: ['the', 'the', 'the'] })
    const recovered = Array.from({ length: 20 }, (_, index) => index).reduce(
      (progress, index) => recordResult(progress, cleanRound, DAY_ONE_NOON + 100 + index).progress,
      practiced,
    )
    expect(weakBigrams(recovered)).toEqual([])
  })

  test('practice words: with a weak pair, a good share of the words hold it', async () => {
    const words = pickWords(ENGLISH_SAMPLE, 400, undefined, ['ck'])
    const practiceShare = words.filter(word => word.includes('ck')).length / words.length

    // About 0.3 by design, plus the words that hold "ck" anyway; random, so a wide margin.
    expect(practiceShare).toBeGreaterThan(0.15)
    expect(pickWords(ENGLISH_SAMPLE, 400).filter(word => word.includes('ck')).length / 400).toBeLessThan(0.1)
  })
})

describe('round lifecycle', () => {
  const running = () => asRunning(applyFieldInput(READY, 0, 0, 't', 0))
  const finished = () => finishByPlayer(running())

  test('a turn ends: a test in progress learns Claude is done; an untouched round stays only in an open game', async () => {
    expect(roundAfter(running(), { kind: 'turnComplete', isGameOpen: false })).toMatchObject({ phase: 'running', isClaudeDone: true })
    expect(roundAfter(READY, { kind: 'turnComplete', isGameOpen: true })).toBe(READY)
    expect(roundAfter(READY, { kind: 'turnComplete', isGameOpen: false })).toBeNull()
    const done = finished()
    expect(roundAfter(done, { kind: 'turnComplete', isGameOpen: false })).toBe(done)
    expect(roundAfter(null, { kind: 'turnComplete', isGameOpen: true })).toBeNull()
  })

  test('the pane closes: a test in progress waits; an untouched round stays only while Claude works; a result goes', async () => {
    const test = running()
    expect(roundAfter(test, { kind: 'paneClosed', isTurnRunning: false })).toBe(test)
    expect(roundAfter(READY, { kind: 'paneClosed', isTurnRunning: true })).toBe(READY)
    expect(roundAfter(READY, { kind: 'paneClosed', isTurnRunning: false })).toBeNull()
    expect(roundAfter(finished(), { kind: 'paneClosed', isTurnRunning: true })).toBeNull()
  })

  test('a round is kept when it serves the need: a test in progress always, an untouched one when the game opens', async () => {
    const needs = ['invitation', 'settings', 'open', 'again'] as const
    const kept = (round: TypingRound | null) => needs.filter(need => keepsRound(round, need))

    expect(kept(running())).toEqual(['invitation', 'settings', 'open'])
    expect(kept(READY)).toEqual(['open'])
    expect(kept(finished())).toEqual([])
    expect(kept(null)).toEqual([])
  })

  test('the band: nothing without a round, the way back in an open game, else the invitation or the result', async () => {
    expect(bandKind(null, false)).toBe('none')
    expect(bandKind(READY, true)).toBe('back')
    expect(bandKind(running(), true)).toBe('back')
    expect(bandKind(finished(), true)).toBe('none')
    expect(bandKind(READY, false)).toBe('invite')
    expect(bandKind(running(), false)).toBe('invite')
    expect(bandKind(finished(), false)).toBe('result')
  })
})

describe('word list order', () => {
  test('the lists show by their file names, in name order, numbers in natural order', async () => {
    const names = ['english', 'code', 'english_10k', 'english_1k', 'english_5k', 'german']
    expect(wordListOrder(names)).toEqual(['code', 'english', 'english_1k', 'english_5k', 'english_10k', 'german'])
  })
})

describe('layout', () => {
  // Each word is 4 cells with its space, so a width of 8 holds two words a line.
  const WORDS = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg']
  const lineTexts = (typed: string) =>
    buildVisibleLines(WORDS, typed, 8, 3).map(line => line.map(run => run.text).join('').trim())

  test('always three lines: the end of the text is padded, so the pane never changes height', async () => {
    expect(lineTexts('aaa bbb ccc ddd eee ')).toEqual(['ccc ddd', 'eee fff', 'ggg'])
    expect(lineTexts('aaa bbb ccc ddd eee fff ')).toEqual(['eee fff', 'ggg', ''])
  })

  test('the current word stays on the second line, with the line just typed above it', async () => {
    expect(lineTexts('')).toEqual(['aaa bbb', 'ccc ddd', 'eee fff'])
    expect(lineTexts('aaa bbb ')).toEqual(['aaa bbb', 'ccc ddd', 'eee fff'])
    expect(lineTexts('aaa bbb ccc ddd ')).toEqual(['ccc ddd', 'eee fff', 'ggg'])
  })

  // The run that holds the caret, by style: where the next key lands.
  const caretRuns = (typed: string) =>
    buildVisibleLines(WORDS, typed, 8, 3)
      .flat()
      .filter(run => run.style === LETTER_STYLE.caret)
      .map(run => ({ text: run.text, style: run.style }))

  test('the caret: on the next letter, then on the space once the word is typed out', async () => {
    expect(caretRuns('')).toEqual([{ text: 'a', style: LETTER_STYLE.caret }])
    expect(caretRuns('aaa bb')).toEqual([{ text: 'b', style: LETTER_STYLE.caret }])
    expect(caretRuns('aaa bbb')).toEqual([{ text: ' ', style: LETTER_STYLE.caret }])
    // A wrong letter or a word typed too long moves the caret on all the same.
    expect(caretRuns('aaa x')).toEqual([{ text: 'b', style: LETTER_STYLE.caret }])
    expect(caretRuns('aaa bbbb')).toEqual([{ text: ' ', style: LETTER_STYLE.caret }])
  })

  // The styles of one word's letters on show, by the word's position in WORDS.
  const wordStyles = (typed: string, wordIndex: number) =>
    buildVisibleLines(WORDS, typed, 8, 3)
      .flat()
      .flatMap(run => [...run.text].map(() => run.style))
      .filter((_, cell) => Math.floor(cell / 4) === wordIndex % 2 && cell % 4 < 3)

  test('a word typed too long stays red once committed, as it was while typed', async () => {
    // "aaa" right, then "bbb" with extra letters: every letter of "bbb" red, before and after the space.
    expect(wordStyles('aaa bbbxx', 1)).toEqual([LETTER_STYLE.incorrect, LETTER_STYLE.incorrect, LETTER_STYLE.incorrect])
    expect(wordStyles('aaa bbbxx ', 1)).toEqual([LETTER_STYLE.incorrect, LETTER_STYLE.incorrect, LETTER_STYLE.incorrect])
    expect(wordStyles('aaa bbbxx ', 0)).toEqual([LETTER_STYLE.correct, LETTER_STYLE.correct, LETTER_STYLE.correct])
  })

  // Each word's underline, by the word's position in WORDS (each is 3 letters and a space).
  const errorWords = (typed: string) =>
    buildVisibleLines(WORDS, typed, 8, 3)
      .flat()
      .flatMap(run => [...run.text].map(() => run.isInErrorWord))
      .filter((_, cell) => cell % 4 < 3)
      .filter((_, letter) => letter % 3 === 0)

  test('a word is underlined only when it has a mistake; the space between words never is', async () => {
    // aaa right ⋅ bbb with a wrong letter ⋅ ccc short (a letter skipped) ⋅ ddd current, on track.
    expect(errorWords('aaa bxb cc dd').slice(0, 4)).toEqual([false, true, true, false])
    // The current word slips: underlined at once.
    expect(errorWords('aaa bx').slice(0, 2)).toEqual([false, true])
    // The space after a word with a mistake is drawn without the underline.
    const spaceRuns = buildVisibleLines(WORDS, 'axa ', 8, 3).flat().filter(run => run.text.trim() === '')
    expect(spaceRuns.length).toBeGreaterThan(0)
    expect(spaceRuns.some(run => run.isInErrorWord)).toBe(false)
  })

  test('big digits: three rows, three cells a digit and one between', async () => {
    const rows = bigNumberRows(40)

    expect(rows).toEqual(['█ █ █▀█', '▀▀█ █ █', '  █ █▄█'])
  })
})

describe('window', () => {
  // 1500 known words, so nothing random is added while 1300 are typed.
  const LONG_WORDS = Array.from({ length: 1500 }, (_, index) => ['alpha', 'be', 'cat', 'dog'][index % 4] ?? 'alpha')
  const READY_LONG: TypingRoundReady = { ...READY, targetWords: LONG_WORDS }
  // Every tenth word mistyped, so the folded scores are not all correct.
  const typedText = (count: number) => LONG_WORDS.slice(0, count).map((word, index) => (index % 10 === 3 ? `x${word}` : word)).join(' ') + ' '
  const countOf = (words: readonly string[], wanted: string) => words.filter(word => word === wanted).length
  const sumScores = (typed: string, targetWords: readonly string[]) =>
    parseTyped(typed).committedWords.reduce(
      (sum, word, index) => {
        const score = scoreWord(word, targetWords[index] ?? '', true)

        return {
          correct: sum.correct + score.correct,
          incorrect: sum.incorrect + score.incorrect,
          extra: sum.extra + score.extra,
          missed: sum.missed + score.missed,
          correctWordCharacters: sum.correctWordCharacters + score.correctWordCharacters,
        }
      },
      { correct: 0, incorrect: 0, extra: 0, missed: 0, correctWordCharacters: 0 },
    )
  // A running round holding `text` as committed text: typing folds by itself (see "long flow").
  const holding = (text: string): TypingRoundRunning => ({ ...asRunning(typeEvenly(READY_LONG, 'alpha ', 0, 10)), typed: text, fieldBaseLength: text.length })

  test('up to 5000 characters of committed text the round is returned as it is', async () => {
    const running = holding(typedText(900))

    expect(running.fieldBaseLength).toBeLessThanOrEqual(5000)
    expect(foldWindow(running)).toBe(running)
  })

  test('past 5000 characters whole words fold, 2500 or more stay, and window plus fold score as the whole text did', async () => {
    const running = holding(typedText(1300))
    const folded = foldWindow(running)
    const foldedWords = folded.fold.words

    expect(running.fieldBaseLength).toBeGreaterThan(5000)
    expect(folded.typed.length).toBeGreaterThanOrEqual(2500)
    // At most one more word could have folded: "xalpha " is the longest.
    expect(folded.typed.length).toBeLessThan(2500 + 'xalpha '.length)
    expect(folded.targetWords[0]).toBe(LONG_WORDS[foldedWords])
    expect(parseTyped(folded.typed).committedWords.length).toBe(1300 - foldedWords)
    expect(folded.typed).toBe(running.typed.slice(folded.fold.droppedCharacters))
    expect(folded.fieldBaseLength).toBe(running.fieldBaseLength - folded.fold.droppedCharacters)

    const whole = sumScores(running.typed, running.targetWords)
    const window = sumScores(folded.typed, folded.targetWords)
    expect({
      correct: folded.fold.chars.correct + window.correct,
      incorrect: folded.fold.chars.incorrect + window.incorrect,
      extra: folded.fold.chars.extra + window.extra,
      missed: folded.fold.chars.missed + window.missed,
      correctWordCharacters: folded.fold.correctWordCharacters + window.correctWordCharacters,
    }).toEqual(whole)
    // Each folded target counts its pairs once: "al" once per "alpha", "be" once per "be".
    const foldedTargets = LONG_WORDS.slice(0, foldedWords)
    expect(folded.fold.bigramAttempts).toMatchObject({ al: countOf(foldedTargets, 'alpha'), be: countOf(foldedTargets, 'be') })
  })

  test('repeated spaces leave with the words they follow', async () => {
    const words = LONG_WORDS.slice(0, 1300)
    const typed = `  ${words.join('  ')}  `
    const folded = foldWindow(holding(typed))

    expect(folded.fold.words).toBeGreaterThan(0)
    expect(folded.typed.split(/ +/).find(word => word !== '')).toBe(words[folded.fold.words])
    expect(folded.typed.length + folded.fold.droppedCharacters).toBe(typed.length)
  })

  test('old per-second samples fold into totals with the same mean and spread', async () => {
    const samples = Array.from({ length: 130 }, (_, index) => index % 7)
    const running: TypingRoundRunning = { ...asRunning(typeEvenly(READY_LONG, 'alpha ', 0, 10)), keystrokesPerSecond: samples }
    const folded = foldWindow(running)

    expect(folded.keystrokesPerSecond).toEqual(samples.slice(70))
    expect(folded.fold.samples).toEqual(totalSamples(samples.slice(0, 70)))
  })
})

describe('long flow', () => {
  const LONG_WORDS = Array.from({ length: 4000 }, (_, index) => ['alpha', 'be', 'cat', 'dog'][index % 4] ?? 'alpha')
  const READY_LONG: TypingRoundReady = { ...READY, targetWords: LONG_WORDS }
  // Every tenth word wrong in its first letter: the same length, as no key past a word's end is typed.
  const typedWord = (index: number) => (index % 10 === 3 ? `x${LONG_WORDS[index]?.slice(1) ?? ''}` : (LONG_WORDS[index] ?? ''))
  const typedText = (count: number) => Array.from({ length: count }, (_, index) => typedWord(index)).join(' ') + ' '

  test('3000 words fold several times and score exactly as the whole text would', async () => {
    const text = typedText(3000)
    // One key every 100 ms: second n holds keys 10n to 10n + 9.
    const windowed = asRunning(typeEvenly(READY_LONG, text, 0, 100))
    const allSamples = Array.from({ length: Math.ceil(text.length / 10) }, (_, second) => Math.min(10, text.length - second * 10))
    const whole: TypingRoundRunning = {
      ...windowed,
      typed: text,
      fieldBaseLength: text.length,
      targetWords: LONG_WORDS,
      keystrokesPerSecond: allSamples,
      fold: EMPTY_FOLD,
    }

    expect(windowed.fold.words).toBeGreaterThan(2000)
    expect(windowed.fieldBaseLength).toBeLessThanOrEqual(5000)
    expect(calculateResult(windowed, 'complete')).toEqual(calculateResult(whole, 'complete'))
  })

  // At the limit: about 5000 characters of typed text, the window's target words as a JSON array,
  // and the folded totals. The field's base is a length, not a second copy of the text.
  test('3600 words of flow keep the round under 16 KB', async () => {
    let round: TypingRound = createRound(1, DEFAULT_SETTINGS, [])
    let now = 0

    for (let wordIndex = 0; wordIndex < 3600 && round.phase !== 'finished'; wordIndex++) {
      const word = round.targetWords[parseTyped(round.phase === 'running' ? round.typed : '').committedWords.length] ?? 'x'
      for (const character of `${word} `) {
        if (round.phase === 'finished') {
          break
        }
        const typed = (round.phase === 'running' ? round.typed : '') + character
        round = applyFieldInput(round, round.fieldIndex, round.fieldBaseLength, typed.slice(round.fieldBaseLength), now)
        now += 200
      }
    }

    expect(round.phase === 'running' && round.fold.words).toBeGreaterThan(2500)
    expect(JSON.stringify(round).length).toBeLessThan(16_000)
  })

  test('a key from the field drawn before a fold lands after the fold, trimmed by what was dropped', async () => {
    // The first word whose space takes the committed text past 5000 characters.
    const crossing = Array.from({ length: 2000 }, (_, count) => count).find(count => typedText(count + 1).length > 5000) ?? 0
    const before = asRunning(typeEvenly(READY_LONG, `${typedText(crossing)}${typedWord(crossing)}`, 0, 100))
    expect(before.fold.words).toBe(0)
    // That space commits the word and folds; the old field's next key arrives late.
    const folded = asRunning(applyFieldInput(before, before.fieldIndex, before.fieldBaseLength, `${typedWord(crossing)} `, 600_000))
    expect(folded.fold.words).toBeGreaterThan(0)

    const nextLetter = LONG_WORDS[crossing + 1]?.[0] ?? 'a'
    const late = asRunning(
      applyFieldInput(folded, before.fieldIndex, before.fieldBaseLength, `${typedWord(crossing)} ${nextLetter}`, 600_100, {
        fieldBaseDropped: before.fold.droppedCharacters,
      }),
    )
    expect(late.typed).toBe(`${folded.typed}${nextLetter}`)
    expect(late.fieldIndex).toBe(folded.fieldIndex)
    expect(late.correctKeystrokes).toBe(folded.correctKeystrokes + 1)
  })

  test('the folded words count as letter-pair attempts', async () => {
    const windowed = asRunning(typeEvenly(READY_LONG, typedText(3000), 0, 100))
    const recorded = recordResult(EMPTY_PROGRESS, finishByPlayer(windowed), DAY_ONE_NOON)

    expect(windowed.fold.words).toBeGreaterThan(0)
    // "alpha" is every fourth of the 3000 words: 750 attempts at "al", folded or not.
    expect(recorded.progress.bigrams['al']?.attempts).toBe(750)
  })
})

describe('word lists', () => {
  const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`)

  test('a list file: words that cannot be typed and repeats are left out', async () => {
    const parsed = parseWordList('code', { words: [...words(20), 'word0', '', 'two words', 'x'.repeat(25), 42, '=>', 'useState'] })

    expect(parsed?.name).toBe('code')
    expect(parsed?.words).toEqual([...words(20), '=>', 'useState'])
  })

  test('a broken file, too few words, or a name that is no file name is no list', async () => {
    expect(parseWordList('code', { words: words(19) })).toBeUndefined()
    expect(parseWordList('code', ['the', 'list'])).toBeUndefined()
    expect(parseWordList('code', null)).toBeUndefined()
    expect(parseWordList('Code Words', { words: words(30) })).toBeUndefined()
    // Size variants, as Monkeytype names them, are valid names.
    expect(parseWordList('english_1k', { words: words(30) })?.name).toBe('english_1k')
  })

  test('a round picks only from its list, records its name, and the personal best is kept per list', async () => {
    const codeList = { name: 'code', words: ['const', 'let', '=>', 'async'] }
    const round = createRound(1, { ...DEFAULT_SETTINGS, mode: 'words', counts: { ...DEFAULT_SETTINGS.counts, words: 10 } }, [], codeList)

    expect(round.wordList).toBe('code')
    expect(round.targetWords.every(word => codeList.words.includes(word))).toBe(true)
    const result = recordResult(EMPTY_PROGRESS, finished({ wpm: 40 }, { mode: 'words', count: round.count, wordList: 'code', targetWords: round.targetWords }), DAY_ONE_NOON)
    expect(Object.keys(result.progress.personalBests)).toEqual(['words:10:code'])
  })

  test('words added ahead in a flow test come from the list passed in', async () => {
    const codeList = ['const', 'let', '=>', 'async']
    const ready = createRound(1, DEFAULT_SETTINGS, [], { name: 'code', words: codeList })
    // 25 words typed: past 40 - 20, so 20 more are added from the list.
    const text = `${ready.targetWords.slice(0, 25).join(' ')} `
    const typed = [...text].reduce<ReturnType<typeof applyFieldInput>>(
      (current, _, index) =>
        current.phase === 'finished'
          ? current
          : applyFieldInput(current, current.fieldIndex, current.fieldBaseLength, text.slice(current.fieldBaseLength, index + 1), index * 100, { words: codeList }),
      ready,
    )

    expect(typed.targetWords.length).toBe(60)
    expect(typed.targetWords.every(word => codeList.includes(word))).toBe(true)
  })
})
