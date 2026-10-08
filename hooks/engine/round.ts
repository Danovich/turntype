import type {
  TypingRound,
  TypingRoundBase,
  TypingRoundEnding,
  TypingRoundFinished,
  TypingRoundReady,
  TypingRoundRunning,
  TypingSettings,
} from '../../types'

import { TYPING_MODE } from './settings'
import { calculateResult, countCorrectWordCharacters } from './stats'
import { activeElapsedMs, isTimeUp, pausedPartOfGap } from './timing'
import { parseTyped } from './typed-text'
import { EMPTY_FOLD, foldOf, foldWindow } from './window'
import { FALLBACK_WORD_LIST, pickWords } from './word-list'
import type { WordList } from './word-list'

/**
 * True: the field is emptied after each word (a new key for each word).
 * False: one field holds the whole test. The fallback if a key change loses the focus.
 */
export const RESET_FIELD_PER_WORD = true

export const ROUND_ENDING = {
  complete: 'complete',
  timeUp: 'timeUp',
  early: 'early',
} as const satisfies Record<TypingRoundEnding, TypingRoundEnding>

const INITIAL_ENDLESS_WORDS = 40
const LOOKAHEAD_WORDS = 20
/**
 * The most text one change of the field adds while a person types: one key, or a few the host
 * coalesced in a fast burst. More is a paste, and a pasted test can never be a personal best.
 */
export const MAX_CHARACTERS_PER_INPUT = 3

/** Modes with no word limit: words are added ahead of the player as they type. */
const isEndless = (round: TypingRoundBase): boolean => round.mode !== TYPING_MODE.words

/**
 * A new round with words from `wordList`; `weakBigrams` are the player's weak letter pairs, practiced
 * when adaptive words are on. The round keeps only the list's name: a key then copies no word list.
 */
export const createRound = (
  roundId: number,
  settings: TypingSettings,
  weakBigrams: readonly string[],
  wordList: WordList = FALLBACK_WORD_LIST,
): TypingRoundReady => {
  const focusBigrams = settings.isAdaptive ? weakBigrams : []

  return {
    roundId,
    mode: settings.mode,
    timeLimitMs: settings.timeSeconds * 1000,
    phase: 'ready',
    targetWords: pickWords(wordList.words, settings.mode === TYPING_MODE.words ? settings.wordCount : INITIAL_ENDLESS_WORDS, undefined, focusBigrams),
    isClaudeDone: false,
    fieldIndex: 0,
    fieldBaseLength: 0,
    fieldValue: '',
    focusBigrams,
    pbWpm: undefined,
    wordList: wordList.name,
  }
}

type KeystrokeTally = {
  readonly committedCount: number
  readonly currentWord: string
  readonly correct: number
  readonly incorrect: number
  readonly correctWordCharacters: number
  readonly didCommit: boolean
  /** Expected letter pairs whose second letter was missed, one entry per wrong key. */
  readonly missedBigrams: readonly string[]
}

/** Scores only the appended characters, as each key was judged when it was pressed. */
const tallyAppended = (previousTyped: string, appended: string, targetWords: readonly string[]): KeystrokeTally => {
  const { committedWords, currentWord } = parseTyped(previousTyped)
  const initial: KeystrokeTally = {
    committedCount: committedWords.length,
    currentWord,
    correct: 0,
    incorrect: 0,
    correctWordCharacters: 0,
    didCommit: false,
    missedBigrams: [],
  }

  return [...appended].reduce<KeystrokeTally>((tally, character) => {
    const targetWord = targetWords[tally.committedCount] ?? ''

    if (character === ' ') {
      if (tally.currentWord === '') {
        return tally
      }
      const isCorrect = tally.currentWord === targetWord

      return {
        committedCount: tally.committedCount + 1,
        currentWord: '',
        correct: tally.correct + (isCorrect ? 1 : 0),
        incorrect: tally.incorrect + (isCorrect ? 0 : 1),
        correctWordCharacters: tally.correctWordCharacters + (isCorrect ? targetWord.length + 1 : 0),
        didCommit: true,
        missedBigrams: tally.missedBigrams,
      }
    }

    const position = tally.currentWord.length
    const isCorrect = character === targetWord[position]
    // The pair the player meant: the target's letter before and the one missed. A word's first
    // letter and letters past its end have no pair. Only while the word is still on track: after
    // a slip every next letter is out of place, and would blame pairs the player did not miss.
    const isOnTrack = targetWord.startsWith(tally.currentWord)
    const missedBigram =
      !isCorrect && isOnTrack && position > 0 && position < targetWord.length ? targetWord.slice(position - 1, position + 1) : undefined

    return {
      ...tally,
      currentWord: tally.currentWord + character,
      correct: tally.correct + (isCorrect ? 1 : 0),
      incorrect: tally.incorrect + (isCorrect ? 0 : 1),
      missedBigrams: missedBigram === undefined ? tally.missedBigrams : [...tally.missedBigrams, missedBigram],
    }
  }, initial)
}

const addToSecond = (perSecond: readonly number[], secondIndex: number, count: number): readonly number[] =>
  Array.from({ length: Math.max(perSecond.length, secondIndex + 1) }, (_, index) =>
    (perSecond[index] ?? 0) + (index === secondIndex ? count : 0),
  )

const addBigramErrors = (
  bigramErrors: Readonly<Record<string, number>>,
  missedBigrams: readonly string[],
): Readonly<Record<string, number>> =>
  missedBigrams.length === 0
    ? bigramErrors
    : missedBigrams.reduce((counts, bigram) => ({ ...counts, [bigram]: (counts[bigram] ?? 0) + 1 }), bigramErrors)

export const finishRound = (round: TypingRoundRunning, ending: TypingRoundEnding): TypingRoundFinished => ({
  roundId: round.roundId,
  mode: round.mode,
  timeLimitMs: round.timeLimitMs,
  targetWords: round.targetWords,
  isClaudeDone: round.isClaudeDone,
  fieldIndex: round.fieldIndex,
  fieldBaseLength: round.fieldBaseLength,
  fieldValue: round.fieldValue,
  focusBigrams: round.focusBigrams,
  pbWpm: round.pbWpm,
  wordList: round.wordList,
  phase: 'finished',
  typed: round.typed,
  ending,
  bigramErrors: round.bigramErrors,
  hasPastedText: round.hasPastedText,
  fold: round.fold,
  result: calculateResult(round, ending),
  progress: undefined,
})

/** The player ends the test (Enter). Flow has no end of its own, so there it is a complete test. */
export const finishByPlayer = (round: TypingRoundRunning): TypingRoundFinished =>
  finishRound(round, round.mode === TYPING_MODE.flow ? ROUND_ENDING.complete : ROUND_ENDING.early)

const isWordsModeComplete = (round: TypingRoundRunning, tally: KeystrokeTally): boolean => {
  const lastTargetWord = round.targetWords.at(-1)

  return (
    tally.committedCount >= round.targetWords.length ||
    (tally.committedCount === round.targetWords.length - 1 && tally.currentWord === lastTargetWord)
  )
}

/** Where the next field starts: unchanged, or a fresh field after a committed word. */
const nextField = (
  round: TypingRoundReady | TypingRoundRunning,
  fieldIndex: number,
  typed: string,
  didCommit: boolean,
): Pick<TypingRoundBase, 'fieldIndex' | 'fieldBaseLength' | 'fieldValue'> => {
  if (!RESET_FIELD_PER_WORD) {
    return { fieldIndex: 0, fieldBaseLength: 0, fieldValue: '' }
  }
  // A late change from a field that was already replaced: the new field is still empty,
  // so the text it held after its word (keys typed before the redraw) joins the base.
  if (fieldIndex < round.fieldIndex) {
    return { fieldIndex: round.fieldIndex, fieldBaseLength: typed.length, fieldValue: '' }
  }

  return didCommit
    ? { fieldIndex: round.fieldIndex + 1, fieldBaseLength: typed.length, fieldValue: '' }
    : { fieldIndex: round.fieldIndex, fieldBaseLength: round.fieldBaseLength, fieldValue: round.fieldValue }
}

/**
 * The typed text with its current word cut to the target word's length, or the text as it is: a
 * word takes no letters past its end, so the next key after a typed-out word is the space. Only the
 * current word: a word already committed (a paste) stays as typed.
 */
const clampCurrentWord = (typed: string, targetWords: readonly string[]): string => {
  const { committedWords, currentWord } = parseTyped(typed)
  const overflow = currentWord.length - (targetWords[committedWords.length] ?? '').length

  return overflow > 0 ? typed.slice(0, typed.length - overflow) : typed
}

/** A fresh field (a new key) holding the current word as cut: the field drawn before shows the keys cut away. */
const withFreshField = <R extends TypingRoundReady | TypingRoundRunning>(round: R, typed: string): R => ({
  ...round,
  fieldIndex: round.fieldIndex + 1,
  fieldValue: typed.slice(round.fieldBaseLength),
})

/** Ends a time test whose active time has run out; any other round is returned as it is. */
export const expireRound = (round: TypingRound, now: number): TypingRound =>
  round.phase === 'running' && isTimeUp(round, now) ? finishRound(round, ROUND_ENDING.timeUp) : round

export type FieldInputOptions = {
  /**
   * How much the window had folded when the field was drawn: a field drawn before a fold counts its
   * base from the old start of the text, so its length is shortened by the difference. Left out:
   * the field is current.
   */
  readonly fieldBaseDropped?: number
  /** The round's word list, for the words added ahead in an endless test. Left out: the fallback list. */
  readonly words?: readonly string[]
}

/**
 * Applies one change of input field `fieldIndex`, whose text follows the first `drawnFieldBaseLength`
 * characters of the typed text, as the field was drawn. Any field's base is the start of the typed
 * text, a late field's too, so the base text is read from it.
 * Deletions and edits count no keystroke, but they are activity: they end an idle gap.
 */
export const applyFieldInput = (
  round: TypingRoundReady | TypingRoundRunning,
  fieldIndex: number,
  drawnFieldBaseLength: number,
  fieldText: string,
  now: number,
  { fieldBaseDropped = foldOf(round).droppedCharacters, words = FALLBACK_WORD_LIST.words }: FieldInputOptions = {},
): TypingRound => {
  const isLateField = fieldIndex < round.fieldIndex
  const previousTyped = round.phase === 'running' ? round.typed : ''
  const baseLength = drawnFieldBaseLength - (foldOf(round).droppedCharacters - fieldBaseDropped)
  const fieldBase = previousTyped.slice(0, Math.min(Math.max(0, baseLength), previousTyped.length))

  // A late change is only taken while the newer field is still empty.
  if (isLateField && previousTyped.length !== round.fieldBaseLength) {
    return round
  }
  // The time ran out while the player was away: the test ends without this key.
  if (round.phase === 'running' && isTimeUp(round, now)) {
    return finishRound(round, ROUND_ENDING.timeUp)
  }
  // Spaces before a word are skipped, but the field would keep them and its cursor would drift
  // right: a fresh, empty field (a new key) takes its place. The typed text does not change.
  if (fieldText !== '' && fieldText.trim() === '') {
    return { ...round, fieldIndex: round.fieldIndex + 1, fieldValue: '' }
  }

  // Keys past a word's end are discarded: left out of the text and the scores, and the field is
  // drawn again holding the word without them.
  const fieldTyped = fieldBase + fieldText
  const typed = clampCurrentWord(fieldTyped, round.targetWords)
  const isClamped = typed !== fieldTyped

  if (isClamped && typed === previousTyped) {
    return withFreshField(round, typed)
  }

  const isAppend = typed.startsWith(previousTyped)
  const appended = isAppend ? typed.slice(previousTyped.length) : ''
  const tally = tallyAppended(previousTyped, appended, round.targetWords)
  const keystrokes = tally.correct + tally.incorrect

  if (round.phase === 'ready' && keystrokes === 0) {
    return round
  }

  const started = round.phase === 'running' ? round : undefined
  const startedAt = started?.startedAt ?? now
  const pausedMs = (started?.pausedMs ?? 0) + (started ? pausedPartOfGap(now - started.lastInputAt) : 0)
  const needsMoreWords = isEndless(round) && tally.committedCount + LOOKAHEAD_WORDS > round.targetWords.length
  const running: TypingRoundRunning = {
    roundId: round.roundId,
    mode: round.mode,
    timeLimitMs: round.timeLimitMs,
    isClaudeDone: round.isClaudeDone,
    focusBigrams: round.focusBigrams,
    pbWpm: round.pbWpm,
    wordList: round.wordList,
    ...nextField(round, fieldIndex, typed, tally.didCommit),
    phase: 'running',
    targetWords: needsMoreWords
      ? [...round.targetWords, ...pickWords(words, LOOKAHEAD_WORDS, round.targetWords.at(-1), round.focusBigrams)]
      : round.targetWords,
    typed,
    startedAt,
    lastInputAt: now,
    pausedMs,
    correctKeystrokes: (started?.correctKeystrokes ?? 0) + tally.correct,
    incorrectKeystrokes: (started?.incorrectKeystrokes ?? 0) + tally.incorrect,
    // Appending adds to the count; a deletion can remove a committed space, so count again.
    correctWordCharacters: isAppend
      ? (started?.correctWordCharacters ?? 0) + tally.correctWordCharacters
      : (started?.fold.correctWordCharacters ?? 0) + countCorrectWordCharacters(typed, round.targetWords),
    keystrokesPerSecond: started?.keystrokesPerSecond ?? [],
    bigramErrors: addBigramErrors(started?.bigramErrors ?? {}, tally.missedBigrams),
    hasPastedText: (started?.hasPastedText ?? false) || appended.length > MAX_CHARACTERS_PER_INPUT,
    fold: started?.fold ?? EMPTY_FOLD,
  }
  // Samples go to active seconds, so a pause adds no empty seconds to the consistency.
  // The array starts after the folded seconds.
  const secondIndex = Math.floor(activeElapsedMs(running, now) / 1000) - running.fold.samples.count
  const sampled: TypingRoundRunning = {
    ...running,
    keystrokesPerSecond: addToSecond(running.keystrokesPerSecond, secondIndex, keystrokes),
  }

  if (sampled.mode === TYPING_MODE.words && isWordsModeComplete(sampled, tally)) {
    return finishRound(sampled, ROUND_ENDING.complete)
  }
  if (sampled.mode === TYPING_MODE.flow && sampled.isClaudeDone && tally.didCommit) {
    return finishRound(sampled, ROUND_ENDING.complete)
  }

  if (isClamped) {
    return withFreshField(sampled, typed)
  }

  // A committed word is final: the time to fold the oldest words once there are enough.
  return tally.didCommit ? foldWindow(sampled) : sampled
}
