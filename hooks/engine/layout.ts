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
  /** The next letter to type, in the current word. */
  caret: 'caret',
  /** The space after a current word typed out: the next key is the space. */
  caretSpace: 'caretSpace',
  space: 'space',
} as const

export type LetterStyle = (typeof LETTER_STYLE)[keyof typeof LETTER_STYLE]

/**
 * Neighbouring letters of one style, drawn as one Text. `isInErrorWord`: the letters belong to a word
 * with a mistake in it (a wrong, skipped or extra letter), which is underlined; its space is not.
 */
export type LetterRun = { readonly text: string; readonly style: LetterStyle; readonly isInErrorWord: boolean }

/** A word as typed has a mistake: committed, unless it is the target exactly; current, once it leaves the target's start. */
const hasError = (typedWord: string | undefined, targetWord: string, isCommitted: boolean): boolean =>
  typedWord !== undefined && (isCommitted ? typedWord !== targetWord : !targetWord.startsWith(typedWord))

export type VisibleLine = readonly LetterRun[]

/** As the word was typed; a word typed too long stays all wrong, as it was while it was current. */
const committedLetterStyle = (typedWord: string, index: number, targetWord: string): LetterStyle => {
  const typedCharacter = typedWord[index]

  if (typedWord.length > targetWord.length) {
    return LETTER_STYLE.incorrect
  }
  if (typedCharacter === undefined) {
    return LETTER_STYLE.missed
  }

  return typedCharacter === targetWord[index] ? LETTER_STYLE.correct : LETTER_STYLE.incorrect
}

/** Letters past the typed text stay highlighted; a word typed too long marks every letter wrong. */
const currentLetterStyle = (typedWord: string, index: number, targetWord: string): LetterStyle => {
  const typedCharacter = typedWord[index]

  if (typedWord.length > targetWord.length) {
    return LETTER_STYLE.currentIncorrect
  }
  if (typedCharacter === undefined) {
    return index === typedWord.length ? LETTER_STYLE.caret : LETTER_STYLE.currentUntyped
  }

  return typedCharacter === targetWord[index] ? LETTER_STYLE.currentCorrect : LETTER_STYLE.currentIncorrect
}

const wordLetters = (targetWord: string, typedWord: string | undefined, isCommitted: boolean, isCurrent: boolean): LetterRun[] => {
  const isInErrorWord = (isCommitted || isCurrent) && hasError(typedWord, targetWord, isCommitted)

  return [...targetWord].map((targetCharacter, index) => ({
    text: targetCharacter,
    style: isCurrent
      ? currentLetterStyle(typedWord ?? '', index, targetWord)
      : isCommitted
        ? committedLetterStyle(typedWord ?? '', index, targetWord)
        : LETTER_STYLE.untyped,
    isInErrorWord,
  }))
}

/** Local accumulation keeps this O(n) per line; the result is never mutated after return. */
const mergeRuns = (letters: readonly LetterRun[]): VisibleLine => {
  const runs: LetterRun[] = []

  for (const letter of letters) {
    const lastRun = runs.at(-1)

    if (lastRun !== undefined && lastRun.style === letter.style && lastRun.isInErrorWord === letter.isInErrorWord) {
      runs[runs.length - 1] = { ...lastRun, text: lastRun.text + letter.text }
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
      const isCurrent = index === currentIndex
      // A typed-out (or too long) current word: the next key is the space, so the caret sits on it.
      const isCaretOnSpace = isCurrent && currentWord.length >= targetWord.length

      return [
        ...wordLetters(targetWord, typedWordAt(index), index < currentIndex, isCurrent),
        { text: ' ', style: isCaretOnSpace ? LETTER_STYLE.caretSpace : LETTER_STYLE.space, isInErrorWord: false },
      ]
    })

    return mergeRuns(letters)
  })

  return [...lines, ...Array.from({ length: Math.max(0, lineCount - lines.length) }, (): VisibleLine => [])]
}
