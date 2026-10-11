import type { TypingRound, TypingRoundRunning } from '../../types'

import { firstKeptWord } from './layout'
import { addBigramAttempts } from './stats'

/*
 * The window: a flow test lasts as long as the turn, and a session can last days. Each committed
 * word is scored once into `scored`, so the words kept are for drawing alone, and the words the
 * pane no longer needs leave the round: everything before the line above the current word's.
 */

/** Committed words that left the window: counted in `scored`, no longer in `typedWords`. None before the first key. */
export const droppedWords = (round: TypingRound): number => (round.phase === 'ready' ? 0 : round.scored.words - round.typedWords.length)

/** Committed words of the whole test, dropped ones included. */
export const committedWordCount = (round: TypingRoundRunning): number => round.scored.words

/**
 * Drops the committed words the pane no longer needs, wrapped to `lineWidth` as the pane wraps them:
 * those before the line just typed. They are scored already; only their target letter pairs are
 * kept, as attempts. Cut at a line start, so every line on show stays as it was. Once per
 * committed word, over the few lines kept; the same round until a line is done.
 */
export const trimWindow = (round: TypingRoundRunning, lineWidth: number): TypingRoundRunning => {
  const dropCount = Math.min(firstKeptWord(round.targetWords, lineWidth, round.typedWords.length), round.typedWords.length)

  return dropCount === 0
    ? round
    : {
        ...round,
        typedWords: round.typedWords.slice(dropCount),
        targetWords: round.targetWords.slice(dropCount),
        droppedBigramAttempts: addBigramAttempts(round.droppedBigramAttempts, round.targetWords.slice(0, dropCount)),
      }
}
