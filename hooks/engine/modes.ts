import type { TypingCountedMode, TypingMode } from '../../types'

/**
 * The one place that knows the game's modes and the settings a person picks: each mode's rules,
 * its counts and their defaults, and the default mode and word list. Everything else derives from
 * it: the defaults, the toolbar's groups, labels, personal-best keys, the end of a test. It imports no code: a type only, which the compiler holds to the table both ways.
 */

/** What ends a test of the mode on its own. */
export type ModeEnd =
  /** Claude is done and the player completes the word (flow: as long as the turn). */
  | 'claudeDone'
  /** The active time, the mode's count in seconds, runs out. */
  | 'timeUp'
  /** The last of the mode's count of words is typed. */
  | 'lastWord'

type CountSpec = {
  /** The counts to pick from, smallest first: the toolbar's options and what `/type` takes. */
  readonly presets: readonly number[]
  readonly default: number
}

type ModeSpec = {
  readonly endsWhen: ModeEnd
  /** What Enter makes of a test before its end: complete (flow has no end of its own) or early. */
  readonly enterEnds: 'complete' | 'early'
  /** A shorter test cannot set a personal best; 0: any length is fair. */
  readonly minFairMs: number
}

/** Every mode, in toolbar order; a mode with a count has its presets, one without has none. */
type ModeTable = {
  readonly [M in TypingMode]: ModeSpec & (M extends TypingCountedMode ? { readonly count: CountSpec } : { readonly count?: undefined })
}

export const MODES: ModeTable = {
  flow: { endsWhen: 'claudeDone', enterEnds: 'complete', minFairMs: 15_000 },
  time: { endsWhen: 'timeUp', enterEnds: 'early', minFairMs: 0, count: { presets: [15, 30, 60, 120], default: 30 } },
  words: { endsWhen: 'lastWord', enterEnds: 'early', minFairMs: 0, count: { presets: [10, 25, 50, 100], default: 25 } },
}

export const DEFAULT_MODE: TypingMode = 'flow'

/** The list a new player types: the 1,000 most common English words. */
export const DEFAULT_WORD_LIST = 'english_1k'

/** The list that is always there: `english.json`, or without it the built-in words. Any list that cannot be had falls back to it. */
export const FALLBACK_LIST_NAME = 'english'

/** The modes in toolbar order. */
export const TYPING_MODES = Object.keys(MODES) as readonly TypingMode[]

export const isTypingMode = (value: unknown): value is TypingMode => typeof value === 'string' && Object.hasOwn(MODES, value)

export const isCountedMode = (mode: TypingMode): mode is TypingCountedMode => MODES[mode].count !== undefined

/** The modes with a count, in toolbar order. */
export const COUNTED_MODES = TYPING_MODES.filter(isCountedMode)

/** Each counted mode's default count. */
export const DEFAULT_COUNTS = Object.fromEntries(COUNTED_MODES.map(mode => [mode, MODES[mode].count.default])) as Readonly<
  Record<TypingCountedMode, number>
>

/** Words keep coming as the player types, unless the mode ends on its last word. */
export const isEndless = (mode: TypingMode): boolean => MODES[mode].endsWhen !== 'lastWord'
