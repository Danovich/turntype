import type {
  TypingCharCounts,
  TypingCurrentSecond,
  TypingResult,
  TypingRoundEnding,
  TypingRoundRunning,
  TypingSampleTotals,
  TypingScored,
} from '../../types'

import { timeLimitMs } from './timing'

const MIN_DURATION_MS = 1000
const CHARACTERS_PER_WORD = 5

/** Maps a coefficient of variation to 0–100: 100 is perfectly even. */
export const kogasa = (coefficientOfVariation: number): number =>
  100 * (1 - Math.tanh(coefficientOfVariation + coefficientOfVariation ** 3 / 3 + coefficientOfVariation ** 5 / 5))

export const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

/** The samples' count, sum and sum of squares: all a mean and a standard deviation need. */
export const totalSamples = (samples: readonly number[]): TypingSampleTotals => ({
  count: samples.length,
  sum: samples.reduce((sum, value) => sum + value, 0),
  sumOfSquares: samples.reduce((sum, value) => sum + value * value, 0),
})

/**
 * A key at active second `index`: counted in the current second, or, in a later one, the seconds
 * before it are finished (those with no key as 0) and it starts the new current second.
 */
export const addToSecond = (
  totals: TypingSampleTotals,
  current: TypingCurrentSecond,
  index: number,
  keystrokes: number,
): { readonly secondTotals: TypingSampleTotals; readonly currentSecond: TypingCurrentSecond } =>
  index <= current.index
    ? { secondTotals: totals, currentSecond: { index: current.index, keystrokes: current.keystrokes + keystrokes } }
    : {
        // The current second, then the seconds between with no key.
        secondTotals: addSampleTotals(totals, {
          count: index - current.index,
          sum: current.keystrokes,
          sumOfSquares: current.keystrokes * current.keystrokes,
        }),
        currentSecond: { index, keystrokes },
      }

export const addSampleTotals = (first: TypingSampleTotals, second: TypingSampleTotals): TypingSampleTotals => ({
  count: first.count + second.count,
  sum: first.sum + second.sum,
  sumOfSquares: first.sumOfSquares + second.sumOfSquares,
})

/** Consistency of the per-second pace from the totals: the same as from every second's count. */
const consistencyOf = (samples: TypingSampleTotals): number => {
  if (samples.count === 0 || samples.sum === 0) {
    return 0
  }
  const average = samples.sum / samples.count
  const variance = Math.max(0, samples.sumOfSquares / samples.count - average * average)

  return kogasa(Math.sqrt(variance) / average)
}

const wordsPerMinute = (characters: number, durationMs: number): number =>
  characters / CHARACTERS_PER_WORD / (durationMs / 60_000)

export type WordScore = TypingCharCounts & { readonly correctWordCharacters: number }

/**
 * Scores one typed word against its target. A committed word earns its space too;
 * the word in progress earns its correct prefix (the test was cut inside it).
 */
export const scoreWord = (typedWord: string, targetWord: string, isCommitted: boolean): WordScore => {
  const counts = { correct: 0, incorrect: 0, extra: 0, missed: 0 }

  for (let index = 0; index < Math.max(typedWord.length, targetWord.length); index++) {
    const typedCharacter = typedWord[index]
    const targetCharacter = targetWord[index]

    if (typedCharacter === undefined) {
      counts.missed += isCommitted ? 1 : 0
    } else if (targetCharacter === undefined) {
      counts.extra++
    } else if (typedCharacter === targetCharacter) {
      counts.correct++
    } else {
      counts.incorrect++
    }
  }

  const isWordCorrect = typedWord === targetWord
  const correctWordCharacters = isWordCorrect
    ? targetWord.length + (isCommitted ? 1 : 0)
    : !isCommitted && targetWord.startsWith(typedWord)
      ? typedWord.length
      : 0

  return { ...counts, correctWordCharacters }
}

/** The letter pairs of a word, in order: "the" is "th" and "he". */
export const bigramsOf = (word: string): readonly string[] =>
  Array.from({ length: Math.max(0, word.length - 1) }, (_, index) => word.slice(index, index + 2))

/** Counts each pair of `words` once per time it occurs, added to `counts`. Local accumulation: O(pairs). */
export const addBigramAttempts = (counts: Readonly<Record<string, number>>, words: readonly string[]): Readonly<Record<string, number>> => {
  const added: Record<string, number> = { ...counts }

  for (const bigram of words.flatMap(bigramsOf)) {
    added[bigram] = (added[bigram] ?? 0) + 1
  }

  return added
}

const addCharCounts = (first: TypingCharCounts, second: TypingCharCounts): TypingCharCounts => ({
  correct: first.correct + second.correct,
  incorrect: first.incorrect + second.incorrect,
  extra: first.extra + second.extra,
  missed: first.missed + second.missed,
})

export const EMPTY_SCORED: TypingScored = {
  words: 0,
  chars: { correct: 0, incorrect: 0, extra: 0, missed: 0 },
  correctWordCharacters: 0,
}

/** Adds committed words to the totals, each scored against its target: once per word, when its space is typed. */
export const addScoredWords = (scored: TypingScored, typedWords: readonly string[], targetWords: readonly string[]): TypingScored =>
  typedWords.length === 0
    ? scored
    : {
        words: scored.words + typedWords.length,
        ...typedWords.reduce(
          (total, typedWord, index) => {
            const score = scoreWord(typedWord, targetWords[index] ?? '', true)

            return { chars: addCharCounts(total.chars, score), correctWordCharacters: total.correctWordCharacters + score.correctWordCharacters }
          },
          { chars: scored.chars, correctWordCharacters: scored.correctWordCharacters },
        ),
      }

/**
 * The test time a result is measured over: exactly the limit of a time test that ran out,
 * else the active time up to the last input (a time test ended early is not divided by the limit).
 */
const resultDurationMs = (round: TypingRoundRunning, ending: TypingRoundEnding): number =>
  ending === 'timeUp'
    ? timeLimitMs(round)
    : Math.max(MIN_DURATION_MS, round.lastInputAt - round.startedAt - round.pausedMs)

/** Live wpm from the committed words' total: O(1), so a key or a tick never scores the whole text. */
export const liveWpm = (round: TypingRoundRunning, activeMs: number): number =>
  Math.round(wordsPerMinute(round.scored.correctWordCharacters, Math.max(MIN_DURATION_MS, activeMs)))

/** The result of the whole test: the committed words' totals, plus the word in progress scored now. */
export const calculateResult = (round: TypingRoundRunning, ending: TypingRoundEnding): TypingResult => {
  const { scored, currentWord } = round
  const currentScore = scoreWord(currentWord, round.targetWords[round.typedWords.length] ?? '', false)
  const durationMs = resultDurationMs(round, ending)
  const keystrokes = round.correctKeystrokes + round.incorrectKeystrokes

  return {
    wpm: Math.round(wordsPerMinute(scored.correctWordCharacters + currentScore.correctWordCharacters, durationMs)),
    raw: Math.round(wordsPerMinute(keystrokes, durationMs)),
    accuracy: keystrokes === 0 ? 0 : Math.round((round.correctKeystrokes / keystrokes) * 100),
    // Scaling every sample (to raw wpm) leaves the ratio of spread to mean as it is.
    consistency: Math.round(consistencyOf(addSampleTotals(round.secondTotals, totalSamples([round.currentSecond.keystrokes])))),
    chars: addCharCounts(scored.chars, currentScore),
    durationMs,
    wordCount: scored.words + (currentWord === '' ? 0 : 1),
  }
}
