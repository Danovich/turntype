import type { Elements } from 'claude-code'

import type { TypingRound, TypingRoundRunning } from '../../types'
import { MODES } from '../engine/modes'
import { committedWordCount } from '../engine/window'

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

/** The mode and its count: `time 30`, `words 25`, `flow`. */
export const modeLabel = (round: TypingRound): string => (round.count === undefined ? round.mode : `${round.mode} ${round.count}`)

export const progressLabel = (round: TypingRoundRunning): string => {
  const committedCount = committedWordCount(round)

  // Out of the count where the test ends on its last word; else the words so far.
  return MODES[round.mode].endsWhen === 'lastWord' ? `${committedCount}/${round.count}` : `${committedCount} ${committedCount === 1 ? 'word' : 'words'}`
}
