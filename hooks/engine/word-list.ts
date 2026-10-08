import { DEFAULT_WORD_LIST } from './modes'

/**
 * A word list: what a test picks its words from. The lists are JSON files in the mod's
 * `word-lists/` folder, `{ "words": [...] }`, named by their file: to add a list, add a file.
 */
export type WordList = {
  readonly name: string
  readonly words: readonly string[]
}


/**
 * The first 50 words of `english.json`, our own list: the game still works when no list file can be
 * read. (The `english_1k`/`_5k`/`_10k` files are Monkeytype's, GPL-3.0: see the README.)
 */
export const FALLBACK_WORD_LIST: WordList = {
  name: DEFAULT_WORD_LIST,
  words: [
    'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'it',
    'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this',
    'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or',
    'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so',
    'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when',
  ],
}

/** A list name is its file name: lowercase letters, digits, underscores and dashes (`english_1k`). */
const LIST_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/
/** Fewer words than this repeat too often to make a test. */
const MIN_LIST_WORDS = 20
const MAX_WORD_LENGTH = 24
/** One word: no whitespace and no control characters; anything else (`=>`, `useState`) is fine. */
const WORD_PATTERN = /^[^\s\p{Cc}]+$/u

export const isWordListName = (name: string): boolean => LIST_NAME_PATTERN.test(name)

/** The lists in toolbar order: by name, numbers in natural order (`english_1k`, `english_5k`, `english_10k`). */
export const wordListOrder = (names: readonly string[]): readonly string[] =>
  names.toSorted((first, second) => first.localeCompare(second, 'en', { numeric: true }))

/**
 * Reads a list file's content. Words that cannot be typed (empty, with a space, too long, not a
 * string) and repeats are left out; a broken file or one with too few words is no list at all.
 */
export const parseWordList = (name: string, value: unknown): WordList | undefined => {
  if (!isWordListName(name) || typeof value !== 'object' || value === null || !('words' in value) || !Array.isArray(value.words)) {
    return undefined
  }
  const words = [
    ...new Set(
      value.words.filter((word): word is string => typeof word === 'string' && word.length <= MAX_WORD_LENGTH && WORD_PATTERN.test(word)),
    ),
  ]

  return words.length >= MIN_LIST_WORDS ? { name, words } : undefined
}

/** The share of words picked for practice when there are weak letter pairs. */
const PRACTICE_SHARE = 0.3

const randomFrom = (words: readonly string[]): string => words[Math.floor(Math.random() * words.length)] ?? words[0] ?? 'the'

/** Words that hold at least one of the letter pairs: O(list) once per pick call, not per word. */
export const wordsWithBigrams = (words: readonly string[], bigrams: readonly string[]): readonly string[] =>
  bigrams.length === 0 ? [] : words.filter(word => bigrams.some(bigram => word.includes(bigram)))

/**
 * Picks `count` random words from `words`, never the same word twice in a row. With
 * `focusBigrams`, about a third of them hold one of those pairs: practice for the player's weak keys.
 */
export const pickWords = (
  words: readonly string[],
  count: number,
  previousWord?: string,
  focusBigrams: readonly string[] = [],
): readonly string[] => {
  const source = words.length >= 2 ? words : FALLBACK_WORD_LIST.words
  const practiceWords = wordsWithBigrams(source, focusBigrams)
  const picked: string[] = []

  while (picked.length < count) {
    const isPractice = practiceWords.length > 1 && Math.random() < PRACTICE_SHARE
    const word = randomFrom(isPractice ? practiceWords : source)

    if (word !== (picked.at(-1) ?? previousWord)) {
      picked.push(word)
    }
  }

  return picked
}
