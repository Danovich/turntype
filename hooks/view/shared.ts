import type { Elements } from 'claude-code'

import type { TypingRound, TypingRoundRunning } from '../../types'
import { TYPING_MODE } from '../engine/settings'
import { committedWordCount, totalTargetWords } from '../engine/window'

/** The elements the views draw with, as `$.ui.resolve(e)` hands them on a surface that has `Input`. */
export type GameElements = Pick<Elements['terminal'], 'Box' | 'Button' | 'Input' | 'Text'>

export type { ActiveRound } from '../engine/lifecycle'

/** One row, never wrapped: a long row cut short keeps the pane height fixed. */
export const ONE_ROW = 'truncate-end'

/** An empty row between each two rows of the pane. */
export const ROW_GAP = 1

export const formatClock = (durationMs: number): string => {
  const totalSeconds = Math.floor(durationMs / 1000)

  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

export const modeLabel = (round: TypingRound): string => {
  if (round.mode === TYPING_MODE.words) {
    return `words ${totalTargetWords(round)}`
  }

  return round.mode === TYPING_MODE.time ? `time ${round.timeLimitMs / 1000}` : 'flow'
}

export const progressLabel = (round: TypingRoundRunning): string => {
  const committedCount = committedWordCount(round)

  return round.mode === TYPING_MODE.words ? `${committedCount}/${totalTargetWords(round)}` : `${committedCount} ${committedCount === 1 ? 'word' : 'words'}`
}
