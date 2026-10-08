export type ParsedTyped = {
  readonly committedWords: readonly string[]
  readonly currentWord: string
}

/**
 * Splits the field's text into committed words and the word in progress.
 * Repeated spaces count as one: a space on an empty word is ignored.
 */
export const parseTyped = (typed: string): ParsedTyped => {
  const words = typed.trimStart().split(/ +/)

  return { committedWords: words.slice(0, -1), currentWord: words.at(-1) ?? '' }
}

/**
 * The typed text from word `fromWord` on, as one string: each committed word with its space, then
 * the current word. O(words after it): the current word alone, but after a late field's keys.
 */
export const textFromWord = (typedWords: readonly string[], currentWord: string, fromWord: number): string =>
  typedWords.slice(fromWord).map(word => `${word} `).join('') + currentWord
