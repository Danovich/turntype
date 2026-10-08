import type { TypingDayStanding, TypingPbOutcome, TypingProgressSummary, TypingRound, TypingRoundFinished } from '../../types'

import { MODES } from './modes'
import { ROUND_ENDING } from './round'
import { addBigramAttempts, mean } from './stats'

/**
 * The saved progress, one `$.store` key per part. Every session on the machine shares the store and
 * a get then a set is not atomic, so a save reads each part again right before it writes it and
 * merges this test into it: a test another session saved meanwhile is kept.
 */
export const PROGRESS_PARTS = ['personalBests', 'history', 'daily', 'bigrams'] as const

export type ProgressPart = (typeof PROGRESS_PARTS)[number]

/** The one record of versions before 0.8: read once, split into the parts, then deleted. */
export const LEGACY_PROGRESS_KEY = 'progress'

const LEGACY_VERSION = 1
const HISTORY_LIMIT = 200
const DAILY_LIMIT = 400
const RECENT_COUNT = 10
const TREND_DAYS = 7
const DAY_MS = 86_400_000
const MIN_ACCURACY = 75
/** Each test the older letter-pair counts weigh this much less, so a fixed weakness fades out. */
const BIGRAM_DECAY = 0.9
const MIN_BIGRAM_ATTEMPTS = 15
const MIN_BIGRAM_ERROR_RATE = 0.04
const FOCUS_BIGRAM_COUNT = 3
const SPARK_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

type PersonalBest = { readonly wpm: number; readonly accuracy: number; readonly at: number }
type HistoryEntry = { readonly key: string; readonly at: number; readonly wpm: number; readonly accuracy: number }
type DailyTotal = { readonly tests: number; readonly activeMs: number }
type BigramStat = { readonly attempts: number; readonly errors: number }

export type StoredProgress = {
  readonly personalBests: Readonly<Record<string, PersonalBest>>
  /** Fair results only, oldest first. */
  readonly history: readonly HistoryEntry[]
  /** Per local day, `YYYY-MM-DD`: every test with at least one word. */
  readonly daily: Readonly<Record<string, DailyTotal>>
  /** Per letter pair: how often it was typed and missed, older tests weighing less. */
  readonly bigrams: Readonly<Record<string, BigramStat>>
}

export const EMPTY_PROGRESS: StoredProgress = { personalBests: {}, history: [], daily: {}, bigrams: {} }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isPersonalBest = (value: unknown): value is PersonalBest =>
  isRecord(value) && isFiniteNumber(value['wpm']) && isFiniteNumber(value['accuracy']) && isFiniteNumber(value['at'])

const isHistoryEntry = (value: unknown): value is HistoryEntry =>
  isRecord(value) &&
  typeof value['key'] === 'string' &&
  isFiniteNumber(value['at']) &&
  isFiniteNumber(value['wpm']) &&
  isFiniteNumber(value['accuracy'])

const isDailyTotal = (value: unknown): value is DailyTotal =>
  isRecord(value) && isFiniteNumber(value['tests']) && isFiniteNumber(value['activeMs'])

const isBigramStat = (value: unknown): value is BigramStat =>
  isRecord(value) && isFiniteNumber(value['attempts']) && isFiniteNumber(value['errors'])

const pickValidEntries = <T>(value: unknown, isValid: (entry: unknown) => entry is T): Record<string, T> =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, T] => isValid(entry[1])))
    : {}

/** Reads each saved part; a missing or broken part starts empty, one odd entry is left out. */
export const PART_PARSERS: { readonly [P in ProgressPart]: (value: unknown) => StoredProgress[P] } = {
  personalBests: value => pickValidEntries(value, isPersonalBest),
  history: value => (Array.isArray(value) ? value.filter(isHistoryEntry) : []),
  daily: value => pickValidEntries(value, isDailyTotal),
  bigrams: value => pickValidEntries(value, isBigramStat),
}

/** The record of versions before 0.8, split into its parts; another version or a broken value is empty. */
export const parseLegacyProgress = (value: unknown): StoredProgress =>
  isRecord(value) && value['version'] === LEGACY_VERSION
    ? {
        personalBests: PART_PARSERS.personalBests(value['personalBests']),
        history: PART_PARSERS.history(value['history']),
        daily: PART_PARSERS.daily(value['daily']),
        bigrams: PART_PARSERS.bigrams(value['bigrams']),
      }
    : EMPTY_PROGRESS

/**
 * A personal best is kept per mode, count and word list (`time:30:english`, `flow:code`): a 15 s
 * sprint never competes with 100 words, nor code with English.
 */
export const configKey = (round: TypingRound): string =>
  [round.mode, ...(round.count === undefined ? [] : [round.count]), round.wordList].join(':')

export const personalBestWpms = (progress: StoredProgress): Readonly<Record<string, number>> =>
  Object.fromEntries(Object.entries(progress.personalBests).map(([key, best]) => [key, best.wpm]))

/** Why a result cannot set a personal best, or undefined when it is a fair test. */
const unfairReason = (round: TypingRoundFinished): string | undefined => {
  if (round.hasPastedText) {
    return 'text was pasted'
  }
  if (round.ending === ROUND_ENDING.early) {
    return 'ended early'
  }
  const { minFairMs } = MODES[round.mode]
  if (round.result.durationMs < minFairMs) {
    return `under ${minFairMs / 1000} s`
  }

  return round.result.accuracy < MIN_ACCURACY ? `accuracy under ${MIN_ACCURACY}%` : undefined
}

/** The local calendar day: a streak follows the player's midnight, not UTC. */
const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const previousDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1)

const countStreak = (daily: StoredProgress['daily'], day: Date): number =>
  daily[dayKey(day)] === undefined ? 0 : 1 + countStreak(daily, previousDay(day))

/** The practice of `now`'s day as saved, and the streak before it. */
export const dayStanding = (daily: StoredProgress['daily'], now: number): TypingDayStanding => {
  const today = new Date(now)
  const total = daily[dayKey(today)] ?? { tests: 0, activeMs: 0 }

  return { day: dayKey(today), tests: total.tests, activeMs: total.activeMs, streakBefore: countStreak(daily, previousDay(today)) }
}

export type TodayPractice = {
  readonly activeMs: number
  /** Days in a row with a test: today's included once played, until then the run that ended yesterday. */
  readonly streakDays: number
  readonly isPlayedToday: boolean
}

/**
 * Today as of `now`, from a standing read that day or the day before (a session open past
 * midnight): yesterday's standing gives a day with nothing typed yet, its streak still alive.
 */
export const todayPractice = (standing: TypingDayStanding, now: number): TodayPractice => {
  const today = new Date(now)

  if (standing.day === dayKey(today)) {
    const isPlayedToday = standing.tests > 0

    return { activeMs: standing.activeMs, streakDays: standing.streakBefore + (isPlayedToday ? 1 : 0), isPlayedToday }
  }
  const isFromYesterday = standing.day === dayKey(previousDay(today))

  return { activeMs: 0, streakDays: isFromYesterday && standing.tests > 0 ? standing.streakBefore + 1 : 0, isPlayedToday: false }
}

const addToDaily = (daily: StoredProgress['daily'], today: string, durationMs: number): StoredProgress['daily'] => {
  const before = daily[today] ?? { tests: 0, activeMs: 0 }
  const entries = Object.entries({ ...daily, [today]: { tests: before.tests + 1, activeMs: before.activeMs + durationMs } })

  return Object.fromEntries(
    entries.toSorted(([firstDay], [secondDay]) => firstDay.localeCompare(secondDay)).slice(-DAILY_LIMIT),
  )
}

const roundToHundredths = (value: number): number => Math.round(value * 100) / 100

/** The part of the current word's target the player reached: its letters as far as typed. */
const reachedInCurrentWord = (round: TypingRoundFinished): string =>
  (round.targetWords[round.typedWords.length] ?? '').slice(0, round.currentWord.length)

/** Weighs the old counts down and adds this test's; a pair that fades below one attempt is dropped. */
const mergeBigrams = (bigrams: StoredProgress['bigrams'], round: TypingRoundFinished): StoredProgress['bigrams'] => {
  // Every pair reached is one attempt: the words that left the window counted as they left, then the
  // window's committed targets and the current word's so far.
  const attempts = addBigramAttempts(round.droppedBigramAttempts, [
    ...round.targetWords.slice(0, round.typedWords.length),
    reachedInCurrentWord(round),
  ])
  const keys = new Set([...Object.keys(bigrams), ...Object.keys(attempts), ...Object.keys(round.bigramErrors)])

  return Object.fromEntries(
    [...keys]
      .map((bigram): [string, BigramStat] => [
        bigram,
        {
          attempts: roundToHundredths((bigrams[bigram]?.attempts ?? 0) * BIGRAM_DECAY + (attempts[bigram] ?? 0)),
          errors: roundToHundredths((bigrams[bigram]?.errors ?? 0) * BIGRAM_DECAY + (round.bigramErrors[bigram] ?? 0)),
        },
      ])
      .filter(([, stat]) => stat.attempts >= 1),
  )
}

/**
 * The player's weakest letter pairs, worst first: enough attempts to judge, and an error rate
 * that is not noise. Smoothing (+5 attempts) keeps one slip on a rare pair from topping the list.
 */
export const weakBigrams = (progress: StoredProgress): readonly string[] =>
  Object.entries(progress.bigrams)
    .filter(([, stat]) => stat.attempts >= MIN_BIGRAM_ATTEMPTS)
    .map(([bigram, stat]) => ({ bigram, errorRate: stat.errors / (stat.attempts + 5) }))
    .filter(({ errorRate }) => errorRate >= MIN_BIGRAM_ERROR_RATE)
    .toSorted((first, second) => second.errorRate - first.errorRate)
    .slice(0, FOCUS_BIGRAM_COUNT)
    .map(({ bigram }) => bigram)

const judgePersonalBest = (wpm: number, previous: PersonalBest | undefined): TypingPbOutcome => {
  if (previous === undefined) {
    return { kind: 'first' }
  }

  return wpm > previous.wpm ? { kind: 'new', previousWpm: previous.wpm } : { kind: 'kept', pbWpm: previous.wpm }
}

/** How one finished test changes each part: applied to the parts as read, or to a fresher copy. */
export type ProgressChanges = { readonly [P in ProgressPart]: (part: StoredProgress[P]) => StoredProgress[P] }

/**
 * The changes of a finished test that ended at `now`. Each one merges, never replaces: a personal
 * best keeps the higher wpm, a result is added once, today's total adds this test. So applied to a
 * part another session changed meanwhile, both tests stay.
 */
export const progressChanges = (round: TypingRoundFinished, now: number): ProgressChanges => {
  const { result } = round
  const key = configKey(round)
  const isFair = unfairReason(round) === undefined
  // Any test with a word is practice data and counts for today, fair or not.
  const hasWords = result.wordCount > 0
  const entry: HistoryEntry = { key, at: now, wpm: result.wpm, accuracy: result.accuracy }

  return {
    personalBests: bests =>
      isFair && (bests[key]?.wpm ?? -1) < result.wpm ? { ...bests, [key]: { wpm: result.wpm, accuracy: result.accuracy, at: now } } : bests,
    history: history =>
      isFair && !history.some(past => past.key === key && past.at === now) ? [...history, entry].slice(-HISTORY_LIMIT) : history,
    daily: daily => (hasWords ? addToDaily(daily, dayKey(new Date(now)), result.durationMs) : daily),
    bigrams: bigrams => (hasWords ? mergeBigrams(bigrams, round) : bigrams),
  }
}

export const applyProgressChanges = (progress: StoredProgress, changes: ProgressChanges): StoredProgress => ({
  personalBests: changes.personalBests(progress.personalBests),
  history: changes.history(progress.history),
  daily: changes.daily(progress.daily),
  bigrams: changes.bigrams(progress.bigrams),
})

export type RecordedProgress = {
  readonly progress: StoredProgress
  readonly summary: TypingProgressSummary
}

/** Adds a finished test to the saved progress and tells how it compares. `now` is when it ended. */
export const recordResult = (progress: StoredProgress, round: TypingRoundFinished, now: number): RecordedProgress => {
  const { result } = round
  const key = configKey(round)
  const recorded = applyProgressChanges(progress, progressChanges(round, now))
  const standing = dayStanding(recorded.daily, now)
  const previousBest = progress.personalBests[key]
  const sameConfigHistory = progress.history.filter(entry => entry.key === key)
  const dayTotals = {
    todayTests: standing.tests,
    todayActiveMs: standing.activeMs,
    streakDays: todayPractice(standing, now).streakDays,
  }
  const reason = unfairReason(round)

  if (reason !== undefined) {
    return {
      progress: recorded,
      summary: {
        pb: { kind: 'unfair', reason, pbWpm: previousBest?.wpm },
        trendDelta: undefined,
        recentWpm: sameConfigHistory.slice(-RECENT_COUNT).map(entry => entry.wpm),
        ...dayTotals,
      },
    }
  }

  const weekWpm = sameConfigHistory.filter(past => past.at >= now - TREND_DAYS * DAY_MS).map(past => past.wpm)

  return {
    progress: recorded,
    summary: {
      pb: judgePersonalBest(result.wpm, previousBest),
      trendDelta: weekWpm.length === 0 ? undefined : Math.round(result.wpm - mean(weekWpm)),
      recentWpm: [...sameConfigHistory, { wpm: result.wpm }].slice(-RECENT_COUNT).map(past => past.wpm),
      ...dayTotals,
    },
  }
}

/** Speeds worth a toast the first time a fair test reaches them: every 10 wpm early on, so a player improving sees one often. */
const WPM_MILESTONES = [40, 50, 60, 70, 80, 90, 100, 120, 150] as const
const STREAK_MILESTONES = [3, 7, 30, 100] as const

const bestWpm = (progress: StoredProgress): number => Math.max(0, ...Object.values(progress.personalBests).map(best => best.wpm))

const streakAt = (progress: StoredProgress, now: number): number => todayPractice(dayStanding(progress.daily, now), now).streakDays

/** The highest milestone passed going from `before` to `after`: `before < m <= after`. */
const highestPassed = (milestones: readonly number[], before: number, after: number): number | undefined =>
  milestones.findLast(milestone => before < milestone && milestone <= after)

/**
 * What a test reached for the first time, from the saved progress before and after it: the
 * highest new speed (any mode or list, fair tests only), and a streak length. No record of its own.
 */
export const milestonesReached = (before: StoredProgress, after: StoredProgress, now: number): readonly string[] => {
  const wpm = highestPassed(WPM_MILESTONES, bestWpm(before), bestWpm(after))
  const streak = highestPassed(STREAK_MILESTONES, streakAt(before, now), streakAt(after, now))

  return [...(wpm === undefined ? [] : [`first ${wpm} wpm test`]), ...(streak === undefined ? [] : [`${streak}-day streak`])]
}

/** One block character per value, scaled from the lowest to the highest; a flat run sits in the middle. */
export const sparkline = (values: readonly number[]): string => {
  const lowest = Math.min(...values)
  const range = Math.max(...values) - lowest

  return values
    .map(value => SPARK_LEVELS[range === 0 ? 3 : Math.round(((value - lowest) / range) * (SPARK_LEVELS.length - 1))])
    .join('')
}
