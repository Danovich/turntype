/** The game's modes; `hooks/engine/modes.ts` holds each one's rules, and the compiler holds it to this list. */
export type TypingMode = 'flow' | 'time' | 'words'

/** The modes with a count to pick: seconds for time, words for words. */
export type TypingCountedMode = 'time' | 'words'

/** What a round is played with: the picks made in the game over the defaults of `modes.ts`, and adaptive from /config. */
export type TypingSettings = {
  readonly mode: TypingMode
  /** Each counted mode's count, kept while another mode is in use. */
  readonly counts: Readonly<Record<TypingCountedMode, number>>
  /** Mix in words with the player's weak letter pairs. */
  readonly isAdaptive: boolean
  /** The name of the word list to pick from: a file in `word-lists/`, without `.json`. */
  readonly wordList: string
}

/** The settings a pick in the game changes, saved in the store; the rest (adaptive) is /config's alone. */
export type TypingPicks = Pick<TypingSettings, 'mode' | 'counts' | 'wordList'>

export type TypingCharCounts = {
  readonly correct: number
  readonly incorrect: number
  readonly extra: number
  readonly missed: number
}

export type TypingResult = {
  readonly wpm: number
  readonly raw: number
  readonly accuracy: number
  readonly consistency: number
  readonly chars: TypingCharCounts
  readonly durationMs: number
  readonly wordCount: number
}

/** Keystrokes-per-second samples as totals: enough for their mean and spread. */
export type TypingSampleTotals = {
  readonly count: number
  readonly sum: number
  readonly sumOfSquares: number
}

/**
 * The committed words of the whole test, each scored once when its space was typed: a committed
 * word is final, so a result is these totals and the word in progress, however long the test.
 */
export type TypingScored = {
  readonly words: number
  readonly chars: TypingCharCounts
  /** Characters of the correctly committed words, with their spaces: what wpm is calculated from. */
  readonly correctWordCharacters: number
}

/** The active second being typed in, and its counted keystrokes so far: added to the totals once a later second starts. */
export type TypingCurrentSecond = {
  readonly index: number
  readonly keystrokes: number
}

export type TypingRoundBase = {
  /** The version of this shape (`ROUND_SHAPE`): a round kept in state over a reload from another version is dropped. */
  readonly shape: number
  readonly roundId: number
  readonly mode: TypingMode
  /** The mode's count when the round was made (seconds for time, words for words); undefined for flow. */
  readonly count: number | undefined
  readonly targetWords: readonly string[]
  readonly isClaudeDone: boolean
  /** Counts the input fields of this round; a new field (new key) starts empty after each word. */
  readonly fieldIndex: number
  /**
   * Where the current field's own text starts: after this many of `typedWords` (window-relative), and
   * this many characters into the next word. The partial count is 0 but after a late field's keys.
   */
  readonly fieldBaseWords: number
  readonly fieldBasePartial: number
  /**
   * The text the current field is drawn holding: empty, or the current word without the keys
   * typed past its end. Fixed for the field's life, so a redraw never resets it.
   */
  readonly fieldValue: string
  /** The weak letter pairs this round practices; empty when adaptive words are off. */
  readonly focusBigrams: readonly string[]
  /** The personal best of this test when the round was made: fixed for the round, so a key reads no other value. */
  readonly pbWpm: number | undefined
  /** The word list the words come from, by name: part of the personal-best key, so lists never compete. */
  readonly wordList: string
}

/** Shown and waiting for the first key. */
export type TypingRoundReady = TypingRoundBase & { readonly phase: 'ready' }

/** Typing in progress: everything the result is calculated from. */
export type TypingRoundRunning = TypingRoundBase & {
  readonly phase: 'running'
  /** The committed words as typed, each final once its space was typed; aligned with `targetWords`. */
  readonly typedWords: readonly string[]
  /** The word being typed: never longer than its target (keys past its end are left out). */
  readonly currentWord: string
  readonly startedAt: number
  /** The last change of the field, keystroke or deletion: the end of the active time so far. */
  readonly lastInputAt: number
  /** Idle time left out of the test: every gap between inputs beyond the idle limit. */
  readonly pausedMs: number
  readonly correctKeystrokes: number
  readonly incorrectKeystrokes: number
  /** Counted keystrokes of each finished active second, as totals; a second with no key counts as 0. */
  readonly secondTotals: TypingSampleTotals
  readonly currentSecond: TypingCurrentSecond
  /** Wrong keys per expected letter pair ("th": an "h" after a "t" was missed), counted when pressed. */
  readonly bigramErrors: Readonly<Record<string, number>>
  /** One change of the field added more text than a person types at once: a paste, not typing. */
  readonly hasPastedText: boolean
  readonly scored: TypingScored
  /** Letter pairs of the target words that left the window, one attempt each; the window's are counted at the end. */
  readonly droppedBigramAttempts: Readonly<Record<string, number>>
}

/** complete: the test reached its end. timeUp: a time test ran out. early: the player ended it first. */
export type TypingRoundEnding = 'complete' | 'timeUp' | 'early'

/** What this result did to the personal best of its configuration. */
export type TypingPbOutcome =
  | { readonly kind: 'first' }
  | { readonly kind: 'new'; readonly previousWpm: number }
  | { readonly kind: 'kept'; readonly pbWpm: number }
  /** Not a fair test (ended early, too short, too inaccurate): it can never set a personal best. */
  | { readonly kind: 'unfair'; readonly reason: string; readonly pbWpm: number | undefined }

/** The progress line under a result, from the saved history. */
export type TypingProgressSummary = {
  readonly pb: TypingPbOutcome
  /** wpm of this result minus the average of the same configuration in the last 7 days. */
  readonly trendDelta: number | undefined
  /** wpm of the last fair results of this configuration, oldest first; this one last when it was fair. */
  readonly recentWpm: readonly number[]
  readonly todayTests: number
  readonly todayActiveMs: number
  /** Days in a row, today included, with at least one test. */
  readonly streakDays: number
}

export type TypingRoundFinished = TypingRoundBase & {
  readonly phase: 'finished'
  readonly typedWords: readonly string[]
  readonly currentWord: string
  readonly ending: TypingRoundEnding
  readonly result: TypingResult
  readonly bigramErrors: Readonly<Record<string, number>>
  readonly hasPastedText: boolean
  readonly scored: TypingScored
  readonly droppedBigramAttempts: Readonly<Record<string, number>>
  /** Added once the result is saved; undefined until then, or when the store failed. */
  readonly progress: TypingProgressSummary | undefined
}

export type TypingRound = TypingRoundReady | TypingRoundRunning | TypingRoundFinished

/** One local day's practice as the store had it, and the streak before it: what the band's daily goal reads. */
export type TypingDayStanding = {
  /** The local day, `YYYY-MM-DD`. */
  readonly day: string
  readonly tests: number
  readonly activeMs: number
  /** Days in a row with a test, ending the day before `day`. */
  readonly streakBefore: number
}

declare module 'claude-code' {
  interface PluginState {
    'turntype': {
      /** The picks made in the game, as saved in the store; null: none, the /config defaults are in use. */
      picks: TypingPicks | null
      round: TypingRound | null
      /** Bumped every second while a test runs, so the timer and live wpm redraw. */
      clockTick: number
      /** The game pane is open: the band steps back to nothing. */
      isGameOpen: boolean
      /** The open game pane holds the keyboard; false after a dialog took it: the band offers the way back. */
      isPaneFocused: boolean
      /** The result card shows its second line of stats (raw, consistency, characters). */
      isDetailsShown: boolean
      /** The toolbar group showing its options (the word lists, or a mode's counts); null: all closed. */
      openOptions: 'list' | TypingCountedMode | null
      /** Personal best wpm per configuration key, loaded from the store: the live vs-PB mark reads it. */
      personalBests: Readonly<Record<string, number>>
      /** The player's weakest letter pairs from the store: new rounds practice them. */
      focusBigrams: readonly string[]
      /** Today's practice and the streak, from the store; null until read, or without a store. */
      dayStanding: TypingDayStanding | null
    }
  }
}
