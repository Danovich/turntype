import { describe, expect, test } from 'claude-code/testing'

import type { TypingMode, TypingSettings } from '../types'
import { DEFAULT_SETTINGS } from '../hooks/engine/settings'
import type { WordList } from '../hooks/engine/word-list'
import * as engineLayout from '../hooks/engine/layout'
import * as engineRound from '../hooks/engine/round'
import * as engineStats from '../hooks/engine/stats'
import * as engineTiming from '../hooks/engine/timing'
import * as engineWindow from '../hooks/engine/window'
import * as legacyLayout from './legacy/layout'
import * as legacyRound from './legacy/round'
import * as legacyStats from './legacy/stats'
import * as legacyTiming from './legacy/timing'
import { parseTyped } from './legacy/typed-text'
import type { TypingRound as LegacyRound } from './legacy/types'
import * as legacyWindow from './legacy/window'

/*
 * Parity of the round-model rewrite: the same seeded key sequences typed into a frozen copy of the
 * old engine (tests/legacy) and into hooks/engine must draw the same lines, show the same live wpm
 * and give the same result after every step. Deleted with tests/legacy once the rewrite is done.
 */

/** What a test shows after a step: what the player sees, and the result once finished. */
type Snapshot = {
  readonly phase: string
  readonly lines: unknown
  readonly liveWpm?: number
  readonly committed?: number
  readonly result?: unknown
}

/** The field as the pane drew it: its key, what it was drawn holding, and the side's own record of it. */
type DrawnField<D> = { readonly key: string; readonly value: string; readonly drawn: D }

/** One engine as the parity test drives it, behind the API it has at a step of the rewrite. */
type Side<R, D> = {
  readonly create: (settings: TypingSettings, weak: readonly string[], list: WordList) => R
  /** The same round with these target words: both sides start from the same words. */
  readonly withWords: (round: R, words: readonly string[]) => R
  readonly field: (round: R) => DrawnField<D>
  readonly input: (round: R, drawn: D, text: string, now: number, words: readonly string[]) => R
  readonly finish: (round: R) => R
  readonly expire: (round: R, now: number) => R
  readonly claudeDone: (round: R) => R
  readonly snapshot: (round: R, now: number) => Snapshot
}

const WIDTH = 60
const LINES = 3

type LegacyField = { readonly fieldIndex: number; readonly baseLength: number; readonly dropped: number }

const legacy: Side<LegacyRound, LegacyField> = {
  create: (settings, weak, list) => legacyRound.createRound(1, settings, weak, list),
  withWords: (round, words) => ({ ...round, targetWords: words }),
  field: round => ({
    key: `f${round.fieldIndex}`,
    value: round.fieldValue,
    drawn: { fieldIndex: round.fieldIndex, baseLength: round.fieldBaseLength, dropped: legacyWindow.foldOf(round).droppedCharacters },
  }),
  input: (round, drawn, text, now, words) =>
    round.phase === 'finished'
      ? round
      : legacyRound.applyFieldInput(round, drawn.fieldIndex, drawn.baseLength, text, now, { fieldBaseDropped: drawn.dropped, words }),
  finish: round => (round.phase === 'running' ? legacyRound.finishByPlayer(round) : round),
  expire: (round, now) => legacyRound.expireRound(round, now),
  claudeDone: round => (round.phase === 'running' ? { ...round, isClaudeDone: true } : round),
  snapshot: (round, now) =>
    round.phase === 'finished'
      ? { phase: round.phase, lines: legacyLayout.buildVisibleLines(round.targetWords, round.typed, WIDTH, LINES), result: round.result }
      : round.phase === 'ready'
        ? { phase: round.phase, lines: legacyLayout.buildVisibleLines(round.targetWords, '', WIDTH, LINES) }
        : {
            phase: round.phase,
            lines: legacyLayout.buildVisibleLines(round.targetWords, round.typed, WIDTH, LINES),
            liveWpm: legacyStats.liveWpm(round, legacyTiming.activeElapsedMs(round, now)),
            committed: legacyWindow.committedWordCount(round),
          },
}

type EngineRound = ReturnType<typeof engineRound.createRound> | ReturnType<typeof engineRound.applyFieldInput>

/** The words the new engine draws: none before the first key. */
const engineTyped = (round: EngineRound): readonly [readonly string[], string] =>
  round.phase === 'ready' ? [[], ''] : [round.typedWords, round.currentWord]

const engine: Side<EngineRound, engineRound.DrawnField> = {
  create: (settings, weak, list) => engineRound.createRound(1, settings, weak, list),
  withWords: (round, words) => ({ ...round, targetWords: words }),
  field: round => ({ key: `f${round.fieldIndex}`, value: round.fieldValue, drawn: engineRound.drawnField(round) }),
  input: (round, drawn, text, now, words) =>
    round.phase === 'finished' ? round : engineRound.applyFieldInput(round, drawn, text, now, words),
  finish: round => (round.phase === 'running' ? engineRound.finishByPlayer(round) : round),
  expire: (round, now) => engineRound.expireRound(round, now),
  claudeDone: round => (round.phase === 'running' ? { ...round, isClaudeDone: true } : round),
  snapshot: (round, now) => {
    const lines = engineLayout.buildVisibleLines(round.targetWords, ...engineTyped(round), WIDTH, LINES)

    return round.phase === 'finished'
      ? { phase: round.phase, lines, result: round.result }
      : round.phase === 'ready'
        ? { phase: round.phase, lines }
        : {
            phase: round.phase,
            lines,
            liveWpm: engineStats.liveWpm(round, engineTiming.activeElapsedMs(round, now)),
            committed: engineWindow.committedWordCount(round),
          }
  },
}

/** A small seeded generator (mulberry32): the same seed, the same sequence. */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Action =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'pause'; readonly ms: number }
  | { readonly kind: 'claudeDone' }
  | { readonly kind: 'finish' }

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/** The next thing the player does, judged from where the old engine stands: mostly right, sometimes not. */
const nextAction = (random: () => number, round: LegacyRound, mode: TypingMode, isLong: boolean, words: readonly string[]): Action => {
  const typed = round.phase === 'running' ? round.typed : ''
  const { committedWords, currentWord } = parseTyped(typed)
  const target = round.targetWords[committedWords.length] ?? ''
  const roll = random()
  const letter = (): string => LETTERS[Math.floor(random() * LETTERS.length)] ?? 'x'

  if (roll < 0.004 && !isLong) {
    return { kind: 'finish' }
  }
  if (roll < 0.006 && mode === 'flow' && !isLong) {
    return { kind: 'claudeDone' }
  }
  if (roll < 0.016) {
    return { kind: 'pause', ms: 3000 + Math.floor(random() * 20_000) }
  }
  if (roll < 0.02 && !isLong) {
    return { kind: 'text', text: ` ${words[0]} ${words[1]} x` }
  }
  if (roll < 0.06) {
    return { kind: 'backspace' }
  }
  if (roll < 0.1) {
    return { kind: 'text', text: letter() }
  }
  if (roll < 0.11) {
    return { kind: 'text', text: '  ' }
  }
  if (roll < 0.13) {
    return { kind: 'text', text: ' ' }
  }
  if (currentWord.length >= target.length) {
    return { kind: 'text', text: roll < 0.15 ? letter() : ' ' }
  }

  return { kind: 'text', text: target[currentWord.length] ?? ' ' }
}

/** One side in the run: its round, and the field the pane shows with the text it holds. */
type Lane<R, D> = { round: R; field: DrawnField<D>; fieldText: string }

const laneOf = <R, D>(side: Side<R, D>, round: R): Lane<R, D> => {
  const field = side.field(round)

  return { round, field, fieldText: field.value }
}

/** The pane redraws after a change: a new field key starts from the value it is drawn holding. */
const redraw = <R, D>(side: Side<R, D>, lane: Lane<R, D>, round: R): Lane<R, D> => {
  const field = side.field(round)

  return field.key === lane.field.key ? { ...lane, round } : { round, field, fieldText: field.value }
}

const step = <R, D>(side: Side<R, D>, lane: Lane<R, D>, action: Action, now: number, words: readonly string[]): Lane<R, D> => {
  const ticked = side.expire(lane.round, now)
  const current = ticked === lane.round ? lane : redraw(side, lane, ticked)

  switch (action.kind) {
    case 'pause':
      return current
    case 'claudeDone':
      return redraw(side, current, side.claudeDone(current.round))
    case 'finish':
      return redraw(side, current, side.finish(current.round))
    case 'backspace':
    case 'text': {
      const fieldText = action.kind === 'backspace' ? current.fieldText.slice(0, -1) : current.fieldText + action.text
      if (fieldText === current.fieldText) {
        return current
      }

      return redraw(side, { ...current, fieldText }, side.input(current.round, current.field.drawn, fieldText, now, words))
    }
  }
}

type Run = {
  readonly seed: number
  readonly mode: TypingMode
  readonly count: number
  readonly steps: number
  readonly isLong: boolean
  /** Compare the views every this many steps (always at the end): long runs compare less often to stay fast. */
  readonly compareEvery: number
}

/** Runs one test on both sides; returns the old side's last round, so a test can check what was covered. */
const runParity = <R, D>(side: Side<R, D>, run: Run): LegacyRound => {
  const settings: TypingSettings = {
    ...DEFAULT_SETTINGS,
    mode: run.mode,
    counts: { ...DEFAULT_SETTINGS.counts, [run.mode === 'words' ? 'words' : 'time']: run.count },
  }
  const weak = run.seed % 3 === 0 ? ['th', 'er'] : []
  // Two words only: pickWords never repeats a word twice in a row, so both sides pick the same words.
  const list: WordList = { name: 'english', words: WORD_PAIRS[run.seed % WORD_PAIRS.length] ?? ['the', 'other'] }
  const actions = seeded(run.seed)
  let oldLane = laneOf(legacy, legacy.create(settings, weak, list))
  let newLane = laneOf(side, side.withWords(side.create(settings, weak, list), oldLane.round.targetWords))
  let now = 1_000_000

  for (let index = 0; index < run.steps && oldLane.round.phase !== 'finished'; index++) {
    const action = nextAction(actions, oldLane.round, run.mode, run.isLong, list.words)
    now += action.kind === 'pause' ? action.ms : 40 + Math.floor(actions() * 260)
    oldLane = step(legacy, oldLane, action, now, list.words)
    newLane = step(side, newLane, action, now, list.words)

    if (index % run.compareEvery !== 0) {
      continue
    }
    const oldSnapshot = legacy.snapshot(oldLane.round, now)
    const newSnapshot = side.snapshot(newLane.round, now)
    if (JSON.stringify(newSnapshot) !== JSON.stringify(oldSnapshot)) {
      expect({ seed: run.seed, mode: run.mode, step: index, action, ...newSnapshot }).toEqual({
        seed: run.seed,
        mode: run.mode,
        step: index,
        action,
        ...oldSnapshot,
      })
    }
  }
  // A test that did not end on its own ends on Enter: the results are compared too.
  const oldEnd = legacy.snapshot(legacy.finish(oldLane.round), now)
  const newEnd = side.snapshot(side.finish(newLane.round), now)
  expect({ seed: run.seed, ...newEnd }).toEqual({ seed: run.seed, ...oldEnd })

  return oldLane.round
}

/** Word pairs of different lengths, so lines wrap at different places. */
const WORD_PAIRS: readonly (readonly string[])[] = [
  ['the', 'other'],
  ['a', 'something'],
  ['under', 'stand'],
  ['in', 'it'],
  ['question', 'mark'],
  ['useState', '=>'],
]

const SHORT_RUNS: readonly Run[] = Array.from({ length: 240 }, (_, index): Run => {
  const mode = (['flow', 'time', 'words'] as const)[index % 3] ?? 'flow'

  return { seed: index + 1, mode, count: mode === 'words' ? [10, 25, 50][index % 3] ?? 25 : [15, 30, 60][index % 3] ?? 30, steps: 400, isLong: false, compareEvery: 1 }
})

/** Flow tests long enough to fold the window (past 5000 characters of committed text). */
const LONG_RUNS: readonly Run[] = [9001, 9002, 9003].map((seed): Run => ({ seed, mode: 'flow', count: 0, steps: 7000, isLong: true, compareEvery: 20 }))

describe('parity: the round model against the frozen old engine', () => {
  test('short tests in every mode: typos, extra letters, spaces, backspaces, pastes, pauses, Enter', async () => {
    for (const run of SHORT_RUNS) {
      runParity(engine, run)
    }
  })

  for (const run of LONG_RUNS) {
    test(`a long flow test past the fold of the window (seed ${run.seed})`, async () => {
      const last = runParity(engine, run)

      // The harness tests what it claims: the old engine did fold.
      expect(last.phase === 'running' ? last.fold.words : 0).toBeGreaterThan(0)
    })
  }
})
