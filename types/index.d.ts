export type TypingMode = 'flow' | 'words' | 'time'

/** What a round is played with, parsed from the manifest's userConfig. */
export type TypingSettings = {
  readonly mode: TypingMode
  readonly wordCount: number
  readonly timeSeconds: number
  /** Mix in words with the player's weak letter pairs. */
  readonly isAdaptive: boolean
  /** The name of the word list to pick from: a file in `word-lists/`, without `.json`. */
  readonly wordList: string
}

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

/** Keystrokes-per-second samples folded out of the window: enough for their mean and spread. */
export type TypingSampleTotals = {
  readonly count: number
  readonly sum: number
  readonly sumOfSquares: number
}

/**
 * What the window folded away from the start of a long test, scored when it was folded, so a
 * result reads the same as if the text were still there. A flow test lasts as long as the turn,
 * and a session can last days: without the fold the round would grow without limit.
 */
export type TypingFold = {
  /** Committed words removed from the start of `typed` and `targetWords`. */
  readonly words: number
  /** Characters removed from the start of `typed`: an input field drawn before a fold trims its base by the difference. */
  readonly droppedCharacters: number
  readonly chars: TypingCharCounts
  /** The folded words' share of the word characters wpm is calculated from. */
  readonly correctWordCharacters: number
  readonly samples: TypingSampleTotals
  /** Letter pairs of the folded target words: one attempt each. */
  readonly bigramAttempts: Readonly<Record<string, number>>
}

export type TypingRoundBase = {
  readonly roundId: number
  readonly mode: TypingMode
  /** The active time a `time` round lasts; unused by the other modes. */
  readonly timeLimitMs: number
  readonly targetWords: readonly string[]
  readonly isClaudeDone: boolean
  /** Counts the input fields of this round; a new field (new key) starts empty after each word. */
  readonly fieldIndex: number
  /**
   * How many characters of `typed` came before the current field's own text: the field's base is
   * always the start of `typed`, so a length, not a second copy of that text.
   */
  readonly fieldBaseLength: number
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
  readonly typed: string
  readonly startedAt: number
  /** The last change of the field, keystroke or deletion: the end of the active time so far. */
  readonly lastInputAt: number
  /** Idle time left out of the test: every gap between inputs beyond the idle limit. */
  readonly pausedMs: number
  readonly correctKeystrokes: number
  readonly incorrectKeystrokes: number
  /** Characters of the correctly committed words, with their spaces: what live wpm reads. */
  readonly correctWordCharacters: number
  /** Counted keystrokes in each active second since the start, less the seconds folded into `fold.samples`. */
  readonly keystrokesPerSecond: readonly number[]
  /** Wrong keys per expected letter pair ("th": an "h" after a "t" was missed), counted when pressed. */
  readonly bigramErrors: Readonly<Record<string, number>>
  /** One change of the field added more text than a person types at once: a paste, not typing. */
  readonly hasPastedText: boolean
  /** The start of the test, folded out of `typed`, `targetWords` and `keystrokesPerSecond`. */
  readonly fold: TypingFold
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
  readonly typed: string
  readonly ending: TypingRoundEnding
  readonly result: TypingResult
  readonly bigramErrors: Readonly<Record<string, number>>
  readonly hasPastedText: boolean
  readonly fold: TypingFold
  /** Added once the result is saved; undefined until then, or when the store failed. */
  readonly progress: TypingProgressSummary | undefined
}

export type TypingRound = TypingRoundReady | TypingRoundRunning | TypingRoundFinished

declare module 'claude-code' {
  interface PluginState {
    'turntype': {
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
      openOptions: 'list' | 'time' | 'words' | null
      /** Personal best wpm per configuration key, loaded from the store: the live vs-PB mark reads it. */
      personalBests: Readonly<Record<string, number>>
      /** The player's weakest letter pairs from the store: new rounds practice them. */
      focusBigrams: readonly string[]
    }
  }
}
