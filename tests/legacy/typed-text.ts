/* Frozen copy of hooks/engine/typed-text.ts before the round-model rewrite: the parity test's reference. */
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
