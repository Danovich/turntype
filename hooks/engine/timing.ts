import type { TypingRoundRunning } from '../../types'

/**
 * One rule pauses every interruption (Esc, a closed pane, a permission prompt, a break):
 * of any gap between two inputs, only this much counts as test time.
 */
export const IDLE_PAUSE_MS = 3000

/** The part of a gap between inputs that is left out of the test. */
export const pausedPartOfGap = (gapMs: number): number => Math.max(0, gapMs - IDLE_PAUSE_MS)

export const isIdle = (round: TypingRoundRunning, now: number): boolean => now - round.lastInputAt > IDLE_PAUSE_MS

/** Test time so far: wall time since the start, less the pauses; it stops while idle. */
export const activeElapsedMs = (round: TypingRoundRunning, now: number): number =>
  Math.min(now, round.lastInputAt + IDLE_PAUSE_MS) - round.startedAt - round.pausedMs

export const isTimeUp = (round: TypingRoundRunning, now: number): boolean =>
  round.mode === 'time' && activeElapsedMs(round, now) >= round.timeLimitMs
