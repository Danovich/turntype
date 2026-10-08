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
import { calculateResult, countCorrectWordCharacters } from './stats'
import { activeElapsedMs, isTimeUp, pausedPartOfGap } from './timing'
import { parseTyped } from './typed-text'
import { EMPTY_FOLD, foldOf, foldWindow } from './window'
import { FALLBACK_WORD_LIST, pickWords } from './word-list'
import type { WordList } from './word-list'

export const ROUND_ENDING = {
  complete: 'complete',
  timeUp: 'timeUp',
  early: 'early',
} as const satisfies Record<TypingRoundEnding, TypingRoundEnding>

/** The version of the round's shape: raised whenever its fields change, so a round kept over a reload from another version is dropped. */
export const ROUND_SHAPE = 2

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
    fieldIndex: 0,
    fieldBaseWords: 0,
    fieldBasePartial: 0,
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
const tallyAppended = (committedCount: number, currentWord: string, appended: string, targetWords: readonly string[]): KeystrokeTally => {
  const initial: KeystrokeTally = {
    committedCount,
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
  shape: round.shape,
  roundId: round.roundId,
  mode: round.mode,
  count: round.count,
  targetWords: round.targetWords,
  isClaudeDone: round.isClaudeDone,
  fieldIndex: round.fieldIndex,
  fieldBaseWords: round.fieldBaseWords,
  fieldBasePartial: round.fieldBasePartial,
  fieldValue: round.fieldValue,
  focusBigrams: round.focusBigrams,
  pbWpm: round.pbWpm,
  wordList: round.wordList,
  phase: 'finished',
  typedWords: round.typedWords,
  currentWord: round.currentWord,
  ending,
  bigramErrors: round.bigramErrors,
  hasPastedText: round.hasPastedText,
  fold: round.fold,
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
 * The typed text from word `fromWord` on, as one string: each committed word with its space, then
 * the current word. O(words after it): the current word alone, but after a late field's keys.
 */
const textFromWord = (typedWords: readonly string[], currentWord: string, fromWord: number): string =>
  typedWords.slice(fromWord).map(word => `${word} `).join('') + currentWord

type FieldPlace = Pick<TypingRoundBase, 'fieldIndex' | 'fieldBaseWords' | 'fieldBasePartial' | 'fieldValue'>

/** Where the next field starts: unchanged, or a fresh field at the end of the text after a committed word. */
const nextField = (
  round: TypingRoundReady | TypingRoundRunning,
  fieldIndex: number,
  typedWords: readonly string[],
  currentWord: string,
  didCommit: boolean,
): FieldPlace => {
  // A late change from a field that was already replaced: the new field is still empty,
  // so the text it held after its word (keys typed before the redraw) joins the base.
  if (fieldIndex < round.fieldIndex) {
    return { fieldIndex: round.fieldIndex, fieldBaseWords: typedWords.length, fieldBasePartial: currentWord.length, fieldValue: '' }
  }

  return didCommit
    ? { fieldIndex: round.fieldIndex + 1, fieldBaseWords: typedWords.length, fieldBasePartial: currentWord.length, fieldValue: '' }
    : { fieldIndex: round.fieldIndex, fieldBaseWords: round.fieldBaseWords, fieldBasePartial: round.fieldBasePartial, fieldValue: round.fieldValue }
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

/** A fresh field (a new key) holding the text after the field's base: the field drawn before shows keys left out. */
const withFreshField = <R extends TypingRoundReady | TypingRoundRunning>(round: R, typedWords: readonly string[], currentWord: string): R => ({
  ...round,
  fieldIndex: round.fieldIndex + 1,
  fieldValue: textFromWord(typedWords, currentWord, round.fieldBaseWords).slice(round.fieldBasePartial),
})

/** The words of `typedWords` before `fromWord`, then `committed`: the same array where nothing changed. */
const joinWords = (typedWords: readonly string[], fromWord: number, committed: readonly string[]): readonly string[] =>
  fromWord + committed.length === typedWords.length && committed.every((word, index) => word === typedWords[fromWord + index])
    ? typedWords
    : [...typedWords.slice(0, fromWord), ...committed]

/** Ends a time test whose active time has run out; any other round is returned as it is. */
export const expireRound = (round: TypingRound, now: number): TypingRound =>
  round.phase === 'running' && isTimeUp(round, now) ? finishRound(round, ROUND_ENDING.timeUp) : round

/**
 * An input field as the pane drew it: its index, where its own text started (after `baseWords`
 * committed words, `basePartial` characters into the next), and how many words the window had
 * folded then. A field drawn before a fold counts its base from the old start, so the words folded
 * since are taken off.
 */
export type DrawnField = {
  readonly fieldIndex: number
  readonly baseWords: number
  readonly basePartial: number
  readonly foldedWords: number
}

/** The round's current field, as the pane draws it now. */
export const drawnField = (round: TypingRound): DrawnField => ({
  fieldIndex: round.fieldIndex,
  baseWords: round.fieldBaseWords,
  basePartial: round.fieldBasePartial,
  foldedWords: foldOf(round).words,
})

/**
 * Applies one change of the input field `field`, whose text follows its base as the field was drawn.
 * Any field's base is a point in the typed text, a late field's too, so the base text is read from it;
 * only the text from the base's word on is looked at, which is the current word but after a late field.
 * Deletions and edits count no keystroke, but they are activity: they end an idle gap.
 * `words`: the round's word list, for the words added ahead in an endless test.
 */
export const applyFieldInput = (
  round: TypingRoundReady | TypingRoundRunning,
  field: DrawnField,
  fieldText: string,
  now: number,
  words: readonly string[] = FALLBACK_WORD_LIST.words,
): TypingRound => {
  const isLateField = field.fieldIndex < round.fieldIndex
  const previousWords = round.phase === 'running' ? round.typedWords : []
  const previousCurrent = round.phase === 'running' ? round.currentWord : ''
  // The field's base in today's window, as a word and a number of characters from that word's start.
  const shiftedBase = field.baseWords - (foldOf(round).words - field.foldedWords)
  const fromWord = Math.min(Math.max(0, shiftedBase), previousWords.length)
  const previousTail = textFromWord(previousWords, previousCurrent, fromWord)
  const basePartial = shiftedBase < 0 ? 0 : shiftedBase > previousWords.length ? previousTail.length : Math.min(field.basePartial, previousTail.length)

  // A late change is only taken while the newer field is still empty.
  if (isLateField && textFromWord(previousWords, previousCurrent, round.fieldBaseWords).length !== round.fieldBasePartial) {
    return round
  }
  // The time ran out while the player was away: the test ends without this key.
  if (round.phase === 'running' && isTimeUp(round, now)) {
    return finishRound(round, ROUND_ENDING.timeUp)
  }
  // One rule for keys that are not typing (a space before a word, a letter past a word's end):
  // they are left out of the text and the scores. Where that leaves the text as it was, the round
  // stays; where the field shows them, a fresh field (a new key) holds the text without them.
  const fieldTyped = previousTail.slice(0, basePartial) + fieldText
  const tail = cleanTypedText(fieldTyped, round.targetWords, fromWord)
  const fieldShowsTyped = tail === fieldTyped

  if (tail === previousTail) {
    return fieldShowsTyped ? round : withFreshField(round, previousWords, previousCurrent)
  }

  const parsedTail = parseTyped(tail)
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
    ...nextField(round, field.fieldIndex, typedWords, currentWord, tally.didCommit),
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
    // Appending adds to the count; a deletion can remove a committed space, so count again.
    correctWordCharacters: isAppend
      ? (started?.correctWordCharacters ?? 0) + tally.correctWordCharacters
      : (started?.fold.correctWordCharacters ?? 0) + countCorrectWordCharacters(typedWords, round.targetWords),
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

  // The mode's own end: its last word, or Claude done and the word completed.
  const { endsWhen } = MODES[sampled.mode]
  if ((endsWhen === 'lastWord' && isLastWordTyped(sampled, tally)) || (endsWhen === 'claudeDone' && sampled.isClaudeDone && tally.didCommit)) {
    return finishRound(sampled, ROUND_ENDING.complete)
  }

  if (!fieldShowsTyped) {
    return withFreshField(sampled, typedWords, currentWord)
  }

  // A committed word is final: the time to fold the oldest words once there are enough.
  return tally.didCommit ? foldWindow(sampled) : sampled
}
