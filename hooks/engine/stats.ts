import type { TypingCharCounts, TypingResult, TypingRoundEnding, TypingRoundRunning, TypingSampleTotals } from '../../types'

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

export const addSampleTotals = (first: TypingSampleTotals, second: TypingSampleTotals): TypingSampleTotals => ({
  count: first.count + second.count,
  sum: first.sum + second.sum,
  sumOfSquares: first.sumOfSquares + second.sumOfSquares,
})

/** Consistency of the per-second pace from the totals: the same with folded seconds as with all of them. */
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

/** Characters of the correctly committed words in the window, with their spaces. O(window): only after a deletion. */
export const countCorrectWordCharacters = (typedWords: readonly string[], targetWords: readonly string[]): number =>
  typedWords.reduce(
    (sum, typedWord, index) => sum + (typedWord === targetWords[index] ? typedWord.length + 1 : 0),
    0,
  )

/**
 * The test time a result is measured over: exactly the limit of a time test that ran out,
 * else the active time up to the last input (a time test ended early is not divided by the limit).
 */
const resultDurationMs = (round: TypingRoundRunning, ending: TypingRoundEnding): number =>
  ending === 'timeUp'
    ? timeLimitMs(round)
    : Math.max(MIN_DURATION_MS, round.lastInputAt - round.startedAt - round.pausedMs)

/** Live wpm from the running counter: O(1), so a key or a tick never scores the whole text. */
export const liveWpm = (round: TypingRoundRunning, activeMs: number): number =>
  Math.round(wordsPerMinute(round.correctWordCharacters, Math.max(MIN_DURATION_MS, activeMs)))

/** The result of the whole test: the window scored now, plus what the window folded away, scored when folded. */
export const calculateResult = (round: TypingRoundRunning, ending: TypingRoundEnding): TypingResult => {
  const { fold } = round
  const { typedWords: committedWords, currentWord } = round
  const committedScores = committedWords.map((typedWord, index) =>
    scoreWord(typedWord, round.targetWords[index] ?? '', true),
  )
  const currentScore = scoreWord(currentWord, round.targetWords[committedWords.length] ?? '', false)
  const scores = [...committedScores, currentScore]
  const total = (pick: (score: WordScore) => number): number => scores.reduce((sum, score) => sum + pick(score), 0)

  const durationMs = resultDurationMs(round, ending)
  const keystrokes = round.correctKeystrokes + round.incorrectKeystrokes

  return {
    wpm: Math.round(wordsPerMinute(fold.correctWordCharacters + total(score => score.correctWordCharacters), durationMs)),
    raw: Math.round(wordsPerMinute(keystrokes, durationMs)),
    accuracy: keystrokes === 0 ? 0 : Math.round((round.correctKeystrokes / keystrokes) * 100),
    // Scaling every sample (to raw wpm) leaves the ratio of spread to mean as it is.
    consistency: Math.round(consistencyOf(addSampleTotals(fold.samples, totalSamples(round.keystrokesPerSecond)))),
    chars: {
      correct: fold.chars.correct + total(score => score.correct),
      incorrect: fold.chars.incorrect + total(score => score.incorrect),
      extra: fold.chars.extra + total(score => score.extra),
      missed: fold.chars.missed + total(score => score.missed),
    },
    durationMs,
    wordCount: fold.words + committedWords.length + (currentWord === '' ? 0 : 1),
  }
}
