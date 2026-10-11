import type { Elements } from 'claude-code'

import type { TypingProgressSummary, TypingRound, TypingRoundFinished, TypingRoundRunning } from '../../types'
import { MODES } from '../engine/modes'
import { committedWordCount } from '../engine/window'

/** The elements the views draw with, as `$.ui.resolve(e)` hands them on a surface that has `Input`. */
export type GameElements = Pick<Elements['terminal'], 'Box' | 'Button' | 'Input' | 'Text'>

export type { ActiveRound } from '../engine/lifecycle'

/** One row, never wrapped: a long row cut short keeps the pane height fixed. */
export const ONE_ROW = 'truncate-end'

/** The dashed rule under the words, dim, as wide as the pane: one row, cut where the pane ends. */
export const rule = ({ Text }: Pick<GameElements, 'Text'>, columns: number) => (
  <Text dimColor wrap={ONE_ROW}>{'╌'.repeat(Math.max(1, columns))}</Text>
)

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

/**
 * One toast for a saved test, or none: a new personal best and the milestones reached, together,
 * so they never queue up. `✦ new personal best: 61 wpm ⋅ time 30 ⋅ first 60 wpm test`.
 */
export const resultToast = (round: TypingRoundFinished, summary: TypingProgressSummary, milestones: readonly string[]): string | undefined => {
  const best = summary.pb.kind === 'new' ? [`new personal best: ${round.result.wpm} wpm ⋅ ${modeLabel(round)}`] : []
  const parts = [...best, ...milestones]

  return parts.length === 0 ? undefined : `✦ ${parts.join(' ⋅ ')}`
}
