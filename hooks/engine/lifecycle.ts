import type { TypingGame, TypingRound, TypingRoundReady, TypingRoundRunning } from '../../types'

import { ROUND_SHAPE } from './round'

/**
 * When a round lives and goes, as plain rules: the shell holds the facts (is the game open, is
 * Claude working) and applies the answer. A test in progress always outlives the turn and the pane
 * that started it; a round never typed in lives only while someone may still play it.
 */

export type ActiveRound = TypingRoundReady | TypingRoundRunning

/** Before or during a test: what a key, the invitation or the way back can act on. */
export const isActive = (round: TypingRound | null): round is ActiveRound => round?.phase === 'ready' || round?.phase === 'running'

/** Something that happened around the game, with the facts the rules read. */
export type RoundEvent =
  /** Claude's turn ended (the main agent's, not a subagent's). */
  | { readonly kind: 'turnComplete'; readonly isGameOpen: boolean }
  /** The person closed the game pane (Esc, the close mark). */
  | { readonly kind: 'paneClosed'; readonly isTurnRunning: boolean }

/**
 * The round after `event`. A turn's end: a test in progress learns Claude is done; an untouched
 * round stays only in an open game. The pane closing: a test in progress waits in the band; an
 * untouched round stays only while Claude still works; a finished one goes with its card.
 */
export const roundAfter = (round: TypingRound | null, event: RoundEvent): TypingRound | null => {
  switch (round?.phase) {
    case 'running':
      return event.kind === 'turnComplete' ? { ...round, isClaudeDone: true } : round
    case 'ready':
      return (event.kind === 'turnComplete' ? event.isGameOpen : event.isTurnRunning) ? round : null
    case 'finished':
      return event.kind === 'turnComplete' ? round : null
    case undefined:
      return null
  }
}

/** A game kept in state over a reload stays only when this version can read its round: the same shape. */
export const readableGame = (game: TypingGame | null): TypingGame | null => (game?.round.shape === ROUND_SHAPE ? game : null)

/**
 * Why the shell wants a round: the invitation after a turn's delay, new settings, the game opened,
 * or "again" on the result card.
 */
export type RoundNeed = 'invitation' | 'settings' | 'open' | 'again'

/**
 * Whether the round there now serves `need`, or a new one is made. A test in progress is never cut
 * short; opening the game keeps an untouched round too; "again" always starts over.
 */
export const keepsRound = (round: TypingRound | null, need: RoundNeed): boolean => {
  switch (need) {
    case 'invitation':
    case 'settings':
      return round?.phase === 'running'
    case 'open':
      return isActive(round)
    case 'again':
      return false
  }
}

/**
 * What the band above the prompt shows. `back`: the game is open but lost the keys (a dialog, a
 * click). `invite`: a round waits with the pane closed (the invitation, or a test to continue).
 * `result`: a test finished while the pane was closed. The shell answers `none` itself, before
 * reading the round, while the open game holds the keys: a key then never draws the band.
 */
export type BandKind = 'none' | 'back' | 'invite' | 'result'

export const bandKind = (round: TypingRound | null, isGameOpen: boolean): BandKind => {
  if (round === null) {
    return 'none'
  }
  if (isGameOpen) {
    return isActive(round) ? 'back' : 'none'
  }

  return round.phase === 'finished' ? 'result' : 'invite'
}
