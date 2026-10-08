import type { TypingRoundBase, TypingRoundRunning } from '../../types'

import { MODES } from './modes'

/**
 * One rule pauses every interruption (Esc, a closed pane, a permission prompt, a break):
 * of any gap between two inputs, only this much counts as test time.
 */
export const IDLE_PAUSE_MS = 2000

/** The part of a gap between inputs that is left out of the test. */
export const pausedPartOfGap = (gapMs: number): number => Math.max(0, gapMs - IDLE_PAUSE_MS)

export const isIdle = (round: TypingRoundRunning, now: number): boolean => now - round.lastInputAt > IDLE_PAUSE_MS

/** Test time so far: wall time since the start, less the pauses; it stops while idle. */
export const activeElapsedMs = (round: TypingRoundRunning, now: number): number =>
  Math.min(now, round.lastInputAt + IDLE_PAUSE_MS) - round.startedAt - round.pausedMs

/** The active time a test lasts: its count in seconds where the mode ends when time is up; else no limit. */
export const timeLimitMs = (round: TypingRoundBase): number =>
  MODES[round.mode].endsWhen === 'timeUp' ? (round.count ?? 0) * 1000 : Number.POSITIVE_INFINITY

export const isTimeUp = (round: TypingRoundRunning, now: number): boolean => activeElapsedMs(round, now) >= timeLimitMs(round)
