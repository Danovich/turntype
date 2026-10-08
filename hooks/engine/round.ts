import type {
  TypingRound,
  TypingRoundBase,
  TypingRoundEnding,
  TypingRoundFinished,
  TypingRoundReady,
  TypingRoundRunning,
  TypingSettings,
} from '../../types'

import { isEndless, MODES } from './modes'
import { countOf } from './settings'
import { addScoredWords, addToSecond, calculateResult, EMPTY_SCORED } from './stats'
import { activeElapsedMs, isTimeUp, pausedPartOfGap } from './timing'
import { parseTyped, textFromWord } from './typed-text'
import { trimWindow } from './window'
import { FALLBACK_WORD_LIST, pickWords } from './word-list'
import type { WordList } from './word-list'

export const ROUND_ENDING = {
  complete: 'complete',
  timeUp: 'timeUp',
  early: 'early',
} as const satisfies Record<TypingRoundEnding, TypingRoundEnding>

/** The version of the round's shape: raised whenever its fields change, so a round kept over a reload from another version is dropped. */
export const ROUND_SHAPE = 5

const EMPTY_SAMPLES = { count: 0, sum: 0, sumOfSquares: 0 } as const
const FIRST_SECOND = { index: 0, keystrokes: 0 } as const

const INITIAL_ENDLESS_WORDS = 40
const LOOKAHEAD_WORDS = 20
/**
 * The most text one change of the field adds while a person types: one key, or a few the host
 * coalesced in a fast burst. More is a paste, and a pasted test can never be a personal best.
 */
export const MAX_CHARACTERS_PER_INPUT = 3

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
  const count = countOf(settings)

  return {
    shape: ROUND_SHAPE,
    roundId,
    mode: settings.mode,
    count,
    phase: 'ready',
    // An endless test starts with enough words to fill the rows; one that ends on its last word has its count.
    targetWords: pickWords(wordList.words, isEndless(settings.mode) ? INITIAL_ENDLESS_WORDS : (count ?? INITIAL_ENDLESS_WORDS), undefined, focusBigrams),
    isClaudeDone: false,
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
  readonly didCommit: boolean
  /** Expected letter pairs whose second letter was missed, one entry per wrong key. */
  readonly missedBigrams: readonly string[]
}

/** Scores only the appended characters, as each key was judged when it was pressed. */
const tallyAppended = (committedCount: number, currentWord: string, appended: string, targetWords: readonly string[]): KeystrokeTally => {
  const initial: KeystrokeTally = {
    committedCount,
    currentWord,
    correct: 0,
    incorrect: 0,
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

const addBigramErrors = (
  bigramErrors: Readonly<Record<string, number>>,
  missedBigrams: readonly string[],
): Readonly<Record<string, number>> =>
  missedBigrams.length === 0
    ? bigramErrors
    : missedBigrams.reduce((counts, bigram) => ({ ...counts, [bigram]: (counts[bigram] ?? 0) + 1 }), bigramErrors)

export const finishRound = (round: TypingRoundRunning, ending: TypingRoundEnding): TypingRoundFinished => ({
  shape: round.shape,
  roundId: round.roundId,
  mode: round.mode,
  count: round.count,
  targetWords: round.targetWords,
  isClaudeDone: round.isClaudeDone,
  focusBigrams: round.focusBigrams,
  pbWpm: round.pbWpm,
  wordList: round.wordList,
  phase: 'finished',
  typedWords: round.typedWords,
  currentWord: round.currentWord,
  ending,
  bigramErrors: round.bigramErrors,
  hasPastedText: round.hasPastedText,
  scored: round.scored,
  droppedBigramAttempts: round.droppedBigramAttempts,
  result: calculateResult(round, ending),
  progress: undefined,
})

/** The player ends the test (Enter): complete in a mode with no end of its own (flow), else early. */
export const finishByPlayer = (round: TypingRoundRunning): TypingRoundFinished =>
  finishRound(round, MODES[round.mode].enterEnds === 'complete' ? ROUND_ENDING.complete : ROUND_ENDING.early)

/** The last word typed: committed, or its last letter in place (no space needed after the last word). */
const isLastWordTyped = (round: TypingRoundRunning, tally: KeystrokeTally): boolean => {
  const lastTargetWord = round.targetWords.at(-1)

  return (
    tally.committedCount >= round.targetWords.length ||
    (tally.committedCount === round.targetWords.length - 1 && tally.currentWord === lastTargetWord)
  )
}

/**
 * Typed text from a committed word on, with what is not typing left out: spaces before a word (only
 * one space ends a word) and letters past the current word's end (the next key after a typed-out
 * word is the space). `fromWord` says which target the text's first word is.
 */
const cleanTypedText = (text: string, targetWords: readonly string[], fromWord: number): string => {
  const spaced = text.replace(/^ +/, '').replace(/ {2,}/g, ' ')
  const { committedWords, currentWord } = parseTyped(spaced)
  const overflow = currentWord.length - (targetWords[fromWord + committedWords.length] ?? '').length

  return overflow > 0 ? spaced.slice(0, spaced.length - overflow) : spaced
}

/** `committed` (the words from `fromWord` on) still holds every committed word from there, as typed. */
const keepsCommittedWords = (typedWords: readonly string[], fromWord: number, committed: readonly string[]): boolean =>
  typedWords.slice(fromWord).every((word, index) => committed[index] === word)

/** The words of `typedWords` before `fromWord`, then `committed`: the same array where nothing changed. */
const joinWords = (typedWords: readonly string[], fromWord: number, committed: readonly string[]): readonly string[] =>
  fromWord + committed.length === typedWords.length && committed.every((word, index) => word === typedWords[fromWord + index])
    ? typedWords
    : [...typedWords.slice(0, fromWord), ...committed]

/** Ends a time test whose active time has run out; any other round is returned as it is. */
export const expireRound = (round: TypingRound, now: number): TypingRound =>
  round.phase === 'running' && isTimeUp(round, now) ? finishRound(round, ROUND_ENDING.timeUp) : round

/** A change of the typed text as the round took it: the round after it, and the text it holds from `fromWord` on. */
export type TypedChange = {
  readonly round: TypingRound
  /** `text` with the keys that are not typing left out: a field showing more holds keys the round did not take. */
  readonly held: string
}

/**
 * What a change needs beside the text: the round's word list (for the words added ahead in an
 * endless test) and the width the pane draws the words at (where the words no longer drawn end).
 */
export type TypingContext = {
  readonly words: readonly string[]
  readonly lineWidth: number
}

/**
 * Applies a change of the typed text from committed word `fromWord` (in the window) on: `text` is
 * what the player has there now. Only that part is looked at, which is the current word alone but
 * after a late field. Undefined when the change is not taken: it would take back a committed word.
 * Deletions and edits count no keystroke, but they are activity: they end an idle gap.
 */
export const applyTyped = (
  round: TypingRoundReady | TypingRoundRunning,
  fromWord: number,
  text: string,
  now: number,
  { words, lineWidth }: TypingContext,
): TypedChange | undefined => {
  const previousWords = round.phase === 'running' ? round.typedWords : []
  const previousCurrent = round.phase === 'running' ? round.currentWord : ''
  const previousTail = textFromWord(previousWords, previousCurrent, fromWord)

  // The time ran out while the player was away: the test ends without this key.
  if (round.phase === 'running' && isTimeUp(round, now)) {
    return { round: finishRound(round, ROUND_ENDING.timeUp), held: previousTail }
  }
  // One rule for keys that are not typing (a space before a word, a letter past a word's end):
  // they are left out of the text and the scores.
  const tail = cleanTypedText(text, round.targetWords, fromWord)

  if (tail === previousTail) {
    return { round, held: tail }
  }

  const parsedTail = parseTyped(tail)
  // A committed word is final: a late change that would take one back (its space deleted) is not taken.
  if (!keepsCommittedWords(previousWords, fromWord, parsedTail.committedWords)) {
    return undefined
  }
  const typedWords = joinWords(previousWords, fromWord, parsedTail.committedWords)
  const { currentWord } = parsedTail
  const isAppend = tail.startsWith(previousTail)
  const appended = isAppend ? tail.slice(previousTail.length) : ''
  const tally = tallyAppended(previousWords.length, previousCurrent, appended, round.targetWords)
  const keystrokes = tally.correct + tally.incorrect

  const started = round.phase === 'running' ? round : undefined
  const startedAt = started?.startedAt ?? now
  const pausedMs = (started?.pausedMs ?? 0) + (started ? pausedPartOfGap(now - started.lastInputAt) : 0)
  const needsMoreWords = isEndless(round.mode) && tally.committedCount + LOOKAHEAD_WORDS > round.targetWords.length
  const running: TypingRoundRunning = {
    shape: round.shape,
    roundId: round.roundId,
    mode: round.mode,
    count: round.count,
    isClaudeDone: round.isClaudeDone,
    focusBigrams: round.focusBigrams,
    pbWpm: round.pbWpm,
    wordList: round.wordList,
    phase: 'running',
    targetWords: needsMoreWords
      ? [...round.targetWords, ...pickWords(words, LOOKAHEAD_WORDS, round.targetWords.at(-1), round.focusBigrams)]
      : round.targetWords,
    typedWords,
    currentWord,
    startedAt,
    lastInputAt: now,
    pausedMs,
    correctKeystrokes: (started?.correctKeystrokes ?? 0) + tally.correct,
    incorrectKeystrokes: (started?.incorrectKeystrokes ?? 0) + tally.incorrect,
    // Each word committed by this change, scored once: it is final from here on.
    scored: addScoredWords(
      started?.scored ?? EMPTY_SCORED,
      typedWords.slice(previousWords.length),
      round.targetWords.slice(previousWords.length),
    ),
    bigramErrors: addBigramErrors(started?.bigramErrors ?? {}, tally.missedBigrams),
    hasPastedText: (started?.hasPastedText ?? false) || appended.length > MAX_CHARACTERS_PER_INPUT,
    droppedBigramAttempts: started?.droppedBigramAttempts ?? {},
    secondTotals: started?.secondTotals ?? EMPTY_SAMPLES,
    currentSecond: started?.currentSecond ?? FIRST_SECOND,
  }
  // Samples go to active seconds, so a pause adds no empty seconds to the consistency.
  const sampled: TypingRoundRunning = {
    ...running,
    ...addToSecond(running.secondTotals, running.currentSecond, Math.floor(activeElapsedMs(running, now) / 1000), keystrokes),
  }

  // The mode's own end: its last word, or Claude done and the word completed.
  const { endsWhen } = MODES[sampled.mode]
  if ((endsWhen === 'lastWord' && isLastWordTyped(sampled, tally)) || (endsWhen === 'claudeDone' && sampled.isClaudeDone && tally.didCommit)) {
    return { round: finishRound(sampled, ROUND_ENDING.complete), held: tail }
  }

  // A committed word is final: the time to drop the oldest words once there are enough.
  return { round: tally.didCommit ? trimWindow(sampled, lineWidth) : sampled, held: tail }
}
