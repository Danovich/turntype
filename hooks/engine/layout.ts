/**
 * The words row shows only the target text: a letter's style says how it was typed,
 * never what was typed (the input field shows that).
 */
export const LETTER_STYLE = {
  correct: 'correct',
  incorrect: 'incorrect',
  /** A letter a finished word went without (typed too short). */
  missed: 'missed',
  untyped: 'untyped',
  /** The next character to type: a letter of the current word, or the space after it once typed out. */
  caret: 'caret',
} as const

export type LetterStyle = (typeof LETTER_STYLE)[keyof typeof LETTER_STYLE]

/**
 * Neighbouring letters of one style, drawn as one Text. `isInErrorWord`: the letters belong to a word
 * with a mistake in it (a wrong, skipped or extra letter), which is underlined; its space is not.
 */
export type LetterRun = { readonly text: string; readonly style: LetterStyle; readonly isInErrorWord: boolean }

export type VisibleLine = readonly LetterRun[]

/** Where a word stands: typed and committed, being typed, or still to come. */
type WordPlace = 'committed' | 'current' | 'ahead'

/** A word as typed has a mistake: committed, unless it is the target exactly; current, once it leaves the target's start. */
const hasError = (typedWord: string, targetWord: string, place: WordPlace): boolean =>
  place === 'committed' ? typedWord !== targetWord : place === 'current' && !targetWord.startsWith(typedWord)

/**
 * One letter as typed. A word typed too long is all wrong. A letter not reached is missed in a
 * committed word; in the current word it is the caret (the next one) or still to type.
 */
const letterStyle = (typedWord: string, index: number, targetWord: string, place: WordPlace): LetterStyle => {
  if (place === 'ahead') {
    return LETTER_STYLE.untyped
  }
  if (typedWord.length > targetWord.length) {
    return LETTER_STYLE.incorrect
  }
  const typedCharacter = typedWord[index]

  if (typedCharacter === undefined) {
    return place === 'committed' ? LETTER_STYLE.missed : index === typedWord.length ? LETTER_STYLE.caret : LETTER_STYLE.untyped
  }

  return typedCharacter === targetWord[index] ? LETTER_STYLE.correct : LETTER_STYLE.incorrect
}

const wordLetters = (targetWord: string, typedWord: string, place: WordPlace): LetterRun[] => {
  const isInErrorWord = hasError(typedWord, targetWord, place)

  return [...targetWord].map((targetCharacter, index) => ({
    text: targetCharacter,
    style: letterStyle(typedWord, index, targetWord, place),
    isInErrorWord,
  }))
}

/** Local accumulation keeps this O(n) per line; the result is never mutated after return. */
const mergeRuns = (pieces: readonly LetterRun[]): VisibleLine => {
  const runs: LetterRun[] = []
  let text = ''
  let first: LetterRun | undefined

  for (const piece of pieces) {
    if (first !== undefined && first.style === piece.style && first.isInErrorWord === piece.isInErrorWord) {
      text += piece.text
    } else {
      if (first !== undefined) {
        runs.push({ text, style: first.style, isInErrorWord: first.isInErrorWord })
      }
      first = piece
      text = piece.text
    }
  }
  if (first !== undefined) {
    runs.push({ text, style: first.style, isInErrorWord: first.isInErrorWord })
  }

  return runs
}

/**
 * Where the lines start when the words wrap to `width` (indexes into `targetWords`), and the line
 * that holds word `wordIndex`. A word goes on a line while it fits with its space. Stops once
 * `linesAfter` lines past that one have started, so the words further ahead are never looked at.
 */
const wrapLines = (
  targetWords: readonly string[],
  width: number,
  wordIndex: number,
  linesAfter: number,
): { readonly lineStarts: readonly number[]; readonly wordLine: number } => {
  const lineStarts: number[] = [0]
  let lineWidth = 0
  let wordLine = 0

  for (const [index, targetWord] of targetWords.entries()) {
    const wordWidth = targetWord.length + 1

    if (lineWidth > 0 && lineWidth + wordWidth > width) {
      if (index > wordIndex && lineStarts.length - 1 - wordLine >= linesAfter) {
        // The line after the last one needed starts here: its start ends that line.
        lineStarts.push(index)
        break
      }
      lineStarts.push(index)
      lineWidth = 0
    }
    lineWidth += wordWidth
    if (index === wordIndex) {
      wordLine = lineStarts.length - 1
    }
  }

  return { lineStarts, wordLine }
}

/**
 * The first word drawn when the words wrap to `width` with word `wordIndex` current: the start of
 * the line above the current word's, the line just typed. Words before it are never drawn again,
 * and cutting the text there leaves every line on show as it was.
 */
export const firstDrawnWord = (targetWords: readonly string[], width: number, wordIndex: number): number => {
  const { lineStarts, wordLine } = wrapLines(targetWords, width, wordIndex, 0)

  return lineStarts[Math.max(0, wordLine - 1)] ?? 0
}

/**
 * Wraps the target words to `width` and returns exactly `lineCount` lines, padded with empty
 * ones, so the pane never changes height. Once the first line is done the current word stays
 * on the second line, with the line just typed above it. Only those lines become runs.
 */
export const buildVisibleLines = (
  targetWords: readonly string[],
  committedWords: readonly string[],
  currentWord: string,
  width: number,
  lineCount: number,
): readonly VisibleLine[] => {
  const currentIndex = committedWords.length
  const placeOf = (index: number): WordPlace => (index < currentIndex ? 'committed' : index === currentIndex ? 'current' : 'ahead')
  const { lineStarts, wordLine: currentLine } = wrapLines(targetWords, width, currentIndex, lineCount)

  const firstLine = Math.max(0, currentLine - 1)
  const lines = lineStarts.slice(firstLine, firstLine + lineCount).map((startIndex, offset) => {
    const endIndex = lineStarts[firstLine + offset + 1] ?? targetWords.length
    const letters = targetWords.slice(startIndex, endIndex).flatMap((targetWord, position) => {
      const index = startIndex + position
      const place = placeOf(index)
      const typedWord = place === 'committed' ? (committedWords[index] ?? '') : place === 'current' ? currentWord : ''
      // A typed-out (or too long) current word: the next key is the space, so the caret sits on it.
      const isCaretOnSpace = place === 'current' && currentWord.length >= targetWord.length
      // A word of one look (ahead, or committed exactly right) is one run; the rest letter by letter.
      const uniform = place === 'ahead' ? LETTER_STYLE.untyped : place === 'committed' && typedWord === targetWord ? LETTER_STYLE.correct : undefined
      const letters = uniform === undefined ? wordLetters(targetWord, typedWord, place) : [{ text: targetWord, style: uniform, isInErrorWord: false }]
      // A space looks the same in any style but the caret's, so it takes its word's last letter's: a
      // run of words that look alike is then one run, one Text. Never underlined, so it ends an error word's run.
      const lastStyle = letters.at(-1)?.style ?? LETTER_STYLE.untyped
      const spaceStyle = isCaretOnSpace ? LETTER_STYLE.caret : lastStyle === LETTER_STYLE.caret ? LETTER_STYLE.untyped : lastStyle

      return [...letters, { text: ' ', style: spaceStyle, isInErrorWord: false }]
    })

    return mergeRuns(letters)
  })

  return [...lines, ...Array.from({ length: Math.max(0, lineCount - lines.length) }, (): VisibleLine => [])]
}
