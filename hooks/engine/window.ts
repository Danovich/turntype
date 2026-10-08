import type { TypingRound, TypingRoundRunning } from '../../types'

import { addBigramAttempts } from './stats'

/**
 * The window: a flow test lasts as long as the turn, and a session can last days. Each committed
 * word is scored once into `scored`, so the words kept are for drawing alone: past this many
 * characters of committed text the oldest ones leave the round.
 */
const DROP_AT_CHARACTERS = 5000
/**
 * Committed text kept after a drop. The word wrap starts at the window's first word, so after a
 * drop its line breaks can differ for a line or two before they match again: this keeps about 12
 * lines above the screen at 200 columns (more when narrower), so that happens out of sight.
 * Counted in characters, not words, because a line is a number of columns, whatever the words.
 */
const KEEP_CHARACTERS = 2500

/** Committed words that left the window: counted in `scored`, no longer in `typedWords`. None before the first key. */
export const droppedWords = (round: TypingRound): number => (round.phase === 'ready' ? 0 : round.scored.words - round.typedWords.length)

/** Committed words of the whole test, dropped ones included. */
export const committedWordCount = (round: TypingRoundRunning): number => round.scored.words

/** Characters of the first `wordCount` committed words, each with its space. O(words): once per committed word. */
const committedLength = (typedWords: readonly string[], wordCount: number): number =>
  typedWords.slice(0, wordCount).reduce((sum, word) => sum + word.length + 1, 0)

/**
 * Drops the oldest committed words of a long round: they are scored already, and only their target
 * letter pairs are kept, as attempts. Only words wholly in the field's base: the field never changes
 * them again. Once per committed word; the same round while the window is short.
 */
export const trimWindow = (round: TypingRoundRunning): TypingRoundRunning => {
  const baseLength = committedLength(round.typedWords, round.fieldBaseWords) + round.fieldBasePartial
  // The common case, after every word: one sum, nothing more.
  if (baseLength <= DROP_AT_CHARACTERS) {
    return round
  }
  // Whole words from the start, as long as at least KEEP_CHARACTERS of committed text stay.
  const droppableLength = baseLength - KEEP_CHARACTERS
  let droppedLength = 0
  let dropCount = 0
  while (dropCount < round.fieldBaseWords) {
    const wordLength = (round.typedWords[dropCount] ?? '').length + 1
    if (droppedLength + wordLength > droppableLength) {
      break
    }
    droppedLength += wordLength
    dropCount += 1
  }

  return dropCount === 0
    ? round
    : {
        ...round,
        typedWords: round.typedWords.slice(dropCount),
        fieldBaseWords: round.fieldBaseWords - dropCount,
        targetWords: round.targetWords.slice(dropCount),
        droppedBigramAttempts: addBigramAttempts(round.droppedBigramAttempts, round.targetWords.slice(0, dropCount)),
      }
}
