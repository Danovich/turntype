import type { TypingField, TypingGame, TypingRound } from '../../types'

import { applyTyped } from './round'
import { textFromWord } from './typed-text'
import { droppedWords } from './window'

/*
 * The input field: the pane types into an Input, which keeps its own text, so each committed word
 * gets a fresh field (a new key) and a field's text is read against where it started. The round
 * knows none of this: it takes "the text from word N on" (applyTyped), and this file works out N
 * and the next field. A surface that hands keys to the mod directly would need none of it.
 */

/** The field a round starts with: the first, empty, at the start of the text. */
export const firstField = (round: TypingRound): TypingField => ({ roundId: round.roundId, index: 0, baseWord: 0, basePartial: 0, value: '' })

/** The game for `round`: its field kept while the round is the same one, a first field for a new one. */
export const gameWith = (game: TypingGame | null, round: TypingRound | null): TypingGame | null =>
  round === null ? null : { round, field: game?.field.roundId === round.roundId ? game.field : firstField(round) }

/** A field as the pane drew it: its round, its index (its key), and where its text started. */
export type FieldAsDrawn = Pick<TypingField, 'roundId' | 'index' | 'baseWord' | 'basePartial'>

/** The field's key in the pane: a new key is a new Input, drawn holding its value. */
export const fieldKey = (field: Pick<TypingField, 'roundId' | 'index'>): string => `r${field.roundId}-f${field.index}`

export const drawnOf = ({ roundId, index, baseWord, basePartial }: TypingField): FieldAsDrawn => ({ roundId, index, baseWord, basePartial })

/** The committed words and the current word: none before the first key. */
const typedOf = (round: TypingRound): readonly [readonly string[], string] => (round.phase === 'ready' ? [[], ''] : [round.typedWords, round.currentWord])

/** The end of the typed text, as a field's base: every committed word, and the current word as far as typed. */
const endOf = (round: TypingRound): Pick<TypingField, 'baseWord' | 'basePartial'> =>
  round.phase === 'ready' ? { baseWord: 0, basePartial: 0 } : { baseWord: round.scored.words, basePartial: round.currentWord.length }

/** A fresh field (a new key) holding the round's text after the field's base: the one drawn before showed keys left out. */
const freshField = (field: TypingField, round: TypingRound): TypingField => {
  const [typedWords, currentWord] = typedOf(round)

  return { ...field, index: field.index + 1, value: textFromWord(typedWords, currentWord, field.baseWord - droppedWords(round)).slice(field.basePartial) }
}

/**
 * Applies one change of the field `drawn`, whose text follows its base as the field was drawn. Its
 * base is a point in the typed text, a late field's too, so the text before it is read from the round.
 * A late change (a field already replaced) is taken only while the newer field is still empty: it
 * holds the keys typed before the redraw. After a committed word the next field starts empty at
 * the end of the text; where the round left keys out, a fresh field holds what it took.
 */
export const applyFieldInput = (game: TypingGame, drawn: FieldAsDrawn, fieldText: string, now: number, words?: readonly string[]): TypingGame => {
  const { round, field } = game

  if (round.phase === 'finished' || drawn.roundId !== round.roundId) {
    return game
  }
  const [typedWords, currentWord] = typedOf(round)
  const dropped = droppedWords(round)
  // The field's base in today's window, as a word and a number of characters from that word's start.
  const shiftedBase = drawn.baseWord - dropped
  const fromWord = Math.min(Math.max(0, shiftedBase), typedWords.length)
  const previousTail = textFromWord(typedWords, currentWord, fromWord)
  const basePartial = shiftedBase < 0 ? 0 : shiftedBase > typedWords.length ? previousTail.length : Math.min(drawn.basePartial, previousTail.length)
  const isLate = drawn.index < field.index

  if (isLate && textFromWord(typedWords, currentWord, field.baseWord - dropped).length !== field.basePartial) {
    return game
  }
  const fieldTyped = previousTail.slice(0, basePartial) + fieldText
  const change = applyTyped(round, fromWord, fieldTyped, now, words)

  if (change === undefined) {
    return game
  }
  const next = change.round
  if (next.phase === 'finished') {
    return { round: next, field }
  }
  const didCommit = next !== round && endOf(next).baseWord > endOf(round).baseWord
  // A late field's keys join the base of the field after it; a committed word starts the next field.
  const placed =
    next !== round && (isLate || didCommit) ? { ...field, ...endOf(next), index: isLate ? field.index : field.index + 1, value: '' } : field

  return { round: next, field: change.held === fieldTyped ? placed : freshField(placed, next) }
}
