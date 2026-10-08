import { parseTyped } from './typed-text'

/**
 * The words row shows only the target text: a letter's style says how it was typed,
 * never what was typed (the input field shows that).
 */
export const LETTER_STYLE = {
  correct: 'correct',
  incorrect: 'incorrect',
  missed: 'missed',
  untyped: 'untyped',
  currentCorrect: 'currentCorrect',
  currentIncorrect: 'currentIncorrect',
  currentUntyped: 'currentUntyped',
  space: 'space',
} as const

export type LetterStyle = (typeof LETTER_STYLE)[keyof typeof LETTER_STYLE]

/** Neighbouring letters of one style, drawn as one Text. */
export type LetterRun = { readonly text: string; readonly style: LetterStyle }

export type VisibleLine = readonly LetterRun[]

const committedLetterStyle = (typedCharacter: string | undefined, targetCharacter: string): LetterStyle => {
  if (typedCharacter === undefined) {
    return LETTER_STYLE.missed
  }

  return typedCharacter === targetCharacter ? LETTER_STYLE.correct : LETTER_STYLE.incorrect
}

/** Letters past the typed text stay highlighted; a word typed too long marks every letter wrong. */
const currentLetterStyle = (typedWord: string, index: number, targetWord: string): LetterStyle => {
  const typedCharacter = typedWord[index]

  if (typedWord.length > targetWord.length) {
    return LETTER_STYLE.currentIncorrect
  }
  if (typedCharacter === undefined) {
    return LETTER_STYLE.currentUntyped
  }

  return typedCharacter === targetWord[index] ? LETTER_STYLE.currentCorrect : LETTER_STYLE.currentIncorrect
}

const wordLetters = (targetWord: string, typedWord: string | undefined, isCommitted: boolean, isCurrent: boolean): LetterRun[] =>
  [...targetWord].map((targetCharacter, index) => ({
    text: targetCharacter,
    style: isCurrent
      ? currentLetterStyle(typedWord ?? '', index, targetWord)
      : isCommitted
        ? committedLetterStyle(typedWord?.[index], targetCharacter)
        : LETTER_STYLE.untyped,
  }))

/** Local accumulation keeps this O(n) per line; the result is never mutated after return. */
const mergeRuns = (letters: readonly LetterRun[]): VisibleLine => {
  const runs: LetterRun[] = []

  for (const letter of letters) {
    const lastRun = runs.at(-1)

    if (lastRun !== undefined && lastRun.style === letter.style) {
      runs[runs.length - 1] = { text: lastRun.text + letter.text, style: lastRun.style }
    } else {
      runs.push(letter)
    }
  }

  return runs
}

/**
 * Wraps the target words to `width` and returns exactly `lineCount` lines, padded with empty
 * ones, so the pane never changes height. Once the first line is done the current word stays
 * on the second line, with the line just typed above it. Only those lines become runs.
 */
export const buildVisibleLines = (
  targetWords: readonly string[],
  typed: string,
  width: number,
  lineCount: number,
): readonly VisibleLine[] => {
  const { committedWords, currentWord } = parseTyped(typed)
  const currentIndex = committedWords.length
  const typedWordAt = (index: number): string | undefined =>
    index < currentIndex ? committedWords[index] : index === currentIndex ? currentWord : undefined

  const lineStarts: number[] = [0]
  let lineWidth = 0
  let currentLine = 0

  targetWords.forEach((targetWord, index) => {
    const wordWidth = targetWord.length + 1

    if (lineWidth > 0 && lineWidth + wordWidth > width) {
      lineStarts.push(index)
      lineWidth = 0
    }
    lineWidth += wordWidth
    if (index === currentIndex) {
      currentLine = lineStarts.length - 1
    }
  })

  const firstLine = Math.max(0, currentLine - 1)
  const lines = lineStarts.slice(firstLine, firstLine + lineCount).map((startIndex, offset) => {
    const endIndex = lineStarts[firstLine + offset + 1] ?? targetWords.length
    const letters = targetWords.slice(startIndex, endIndex).flatMap((targetWord, position) => {
      const index = startIndex + position

      return [
        ...wordLetters(targetWord, typedWordAt(index), index < currentIndex, index === currentIndex),
        { text: ' ', style: LETTER_STYLE.space },
      ]
    })

    return mergeRuns(letters)
  })

  return [...lines, ...Array.from({ length: Math.max(0, lineCount - lines.length) }, (): VisibleLine => [])]
}
