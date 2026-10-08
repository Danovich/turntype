import type { TypingCharCounts, TypingFold, TypingRound, TypingRoundRunning } from '../../types'

import { addSampleTotals, scoreWord, totalSamples } from './stats'

/**
 * The window: a flow test lasts as long as the turn, and a session can last days. Past this many
 * characters of committed text in the round, the oldest words are folded into totals and removed.
 */
const FOLD_AT_CHARACTERS = 5000
/**
 * Committed text kept after a fold. The word wrap starts at the window's first word, so after a
 * fold its line breaks can differ for a line or two before they match again: this keeps about 12
 * lines above the screen at 200 columns (more when narrower), so that happens out of sight.
 * Counted in characters, not words, because a line is a number of columns, whatever the words.
 */
const KEEP_CHARACTERS = 2500
const FOLD_AT_SECONDS = 120
const KEEP_SECONDS = 60

export const EMPTY_FOLD: TypingFold = {
  words: 0,
  droppedCharacters: 0,
  chars: { correct: 0, incorrect: 0, extra: 0, missed: 0 },
  correctWordCharacters: 0,
  samples: { count: 0, sum: 0, sumOfSquares: 0 },
  bigramAttempts: {},
}

/** What a round has folded away: nothing before the first key. */
export const foldOf = (round: TypingRound): TypingFold => (round.phase === 'ready' ? EMPTY_FOLD : round.fold)

/** The target words of the whole test, folded ones included: what a words test is named by. */
export const totalTargetWords = (round: TypingRound): number => foldOf(round).words + round.targetWords.length

/** Committed words of the whole test, folded ones included. */
export const committedWordCount = (round: TypingRoundRunning): number => round.fold.words + round.typedWords.length

/** The letter pairs of a word, in order: "the" is "th" and "he". */
export const bigramsOf = (word: string): readonly string[] =>
  Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2))

/** Counts each pair of `words` once per time it occurs, added to `counts`. Local accumulation: O(pairs). */
export const addBigramAttempts = (counts: Readonly<Record<string, number>>, words: readonly string[]): Readonly<Record<string, number>> => {
  const added: Record<string, number> = { ...counts }

  for (const bigram of words.flatMap(bigramsOf)) {
    added[bigram] = (added[bigram] ?? 0) + 1
  }

  return added
}

const addCharCounts = (first: TypingCharCounts, second: TypingCharCounts): TypingCharCounts => ({
  correct: first.correct + second.correct,
  incorrect: first.incorrect + second.incorrect,
  extra: first.extra + second.extra,
  missed: first.missed + second.missed,
})

/** Characters of the first `wordCount` committed words, each with its space. O(words): once per committed word. */
const committedLength = (typedWords: readonly string[], wordCount: number): number =>
  typedWords.slice(0, wordCount).reduce((sum, word) => sum + word.length + 1, 0)

/** Folds the oldest committed words out of a long round. Only words wholly in the field's base: the field never changes them again. */
const foldWords = (round: TypingRoundRunning): TypingRoundRunning => {
  const baseLength = committedLength(round.typedWords, round.fieldBaseWords) + round.fieldBasePartial
  // The common case, after every word: one sum, nothing more.
  if (baseLength <= FOLD_AT_CHARACTERS) {
    return round
  }
  // Whole words from the start, as long as at least KEEP_CHARACTERS of committed text stay.
  const foldableLength = baseLength - KEEP_CHARACTERS
  let droppedLength = 0
  let foldCount = 0
  while (foldCount < round.fieldBaseWords) {
    const wordLength = (round.typedWords[foldCount] ?? '').length + 1
    if (droppedLength + wordLength > foldableLength) {
      break
    }
    droppedLength += wordLength
    foldCount += 1
  }

  if (foldCount === 0) {
    return round
  }
  const foldedTargets = round.targetWords.slice(0, foldCount)
  const scores = round.typedWords.slice(0, foldCount).map((typedWord, index) => scoreWord(typedWord, foldedTargets[index] ?? '', true))

  return {
    ...round,
    typedWords: round.typedWords.slice(foldCount),
    fieldBaseWords: round.fieldBaseWords - foldCount,
    targetWords: round.targetWords.slice(foldCount),
    fold: {
      ...round.fold,
      words: round.fold.words + foldCount,
      droppedCharacters: round.fold.droppedCharacters + droppedLength,
      chars: scores.reduce<TypingCharCounts>(addCharCounts, round.fold.chars),
      correctWordCharacters: scores.reduce((sum, score) => sum + score.correctWordCharacters, round.fold.correctWordCharacters),
      bigramAttempts: addBigramAttempts(round.fold.bigramAttempts, foldedTargets),
    },
  }
}

/** Folds the oldest per-second samples. Active time only grows, so a folded second is never written again. */
const foldSamples = (round: TypingRoundRunning): TypingRoundRunning => {
  if (round.keystrokesPerSecond.length <= FOLD_AT_SECONDS) {
    return round
  }
  const foldCount = round.keystrokesPerSecond.length - KEEP_SECONDS

  return {
    ...round,
    keystrokesPerSecond: round.keystrokesPerSecond.slice(foldCount),
    fold: { ...round.fold, samples: addSampleTotals(round.fold.samples, totalSamples(round.keystrokesPerSecond.slice(0, foldCount))) },
  }
}

/** Keeps a running round bounded: folds old words and old samples once there are enough of them; else the same round. */
export const foldWindow = (round: TypingRoundRunning): TypingRoundRunning => foldSamples(foldWords(round))
