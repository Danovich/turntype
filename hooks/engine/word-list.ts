/**
 * A word list: what a test picks its words from. The lists are JSON files in the mod's
 * `word-lists/` folder, `{ "words": [...] }`, named by their file: to add a list, add a file.
 */
export type WordList = {
  readonly name: string
  readonly words: readonly string[]
}

export const DEFAULT_WORD_LIST_NAME = 'english'

/**
 * The first 50 words of `english.json`, our own list: the game still works when no list file can be
 * read. (The `english_1k`/`_5k`/`_10k` files are Monkeytype's, GPL-3.0: see the README.)
 */
export const FALLBACK_WORD_LIST: WordList = {
  name: DEFAULT_WORD_LIST_NAME,
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

/** A size variant of another list (`english_10k` of `english`): its base and its suffix. */
const VARIANT_PATTERN = /^(.+)_([^_]+)$/

const variantOf = (name: string, names: readonly string[]): { readonly base: string; readonly suffix: string } | undefined => {
  const match = VARIANT_PATTERN.exec(name)

  return match?.[1] !== undefined && match[2] !== undefined && names.includes(match[1]) ? { base: match[1], suffix: match[2] } : undefined
}

/** The list's name in the toolbar: a variant of a list on show is its suffix alone (`10k`), so the row stays short. */
export const wordListLabel = (name: string, names: readonly string[]): string => variantOf(name, names)?.suffix ?? name

/**
 * The lists in toolbar order: the default list's family first, each family its base then its
 * variants smallest first (`english 1k 5k 10k`), then the other families by name (`code`).
 */
export const wordListOrder = (names: readonly string[]): readonly string[] => {
  const sortKey = (name: string) => {
    const variant = variantOf(name, names)
    const base = variant?.base ?? name

    return { isDefault: base === DEFAULT_WORD_LIST_NAME ? 0 : 1, base, size: variant === undefined ? 0 : Number.parseFloat(variant.suffix) || Infinity }
  }

  return names.toSorted((first, second) => {
    const [a, b] = [sortKey(first), sortKey(second)]

    return a.isDefault - b.isDefault || a.base.localeCompare(b.base) || a.size - b.size || first.localeCompare(second)
  })
}

/** The list a person named: its full name, or its toolbar label (`10k`); undefined when none. */
export const findWordListName = (token: string, names: readonly string[]): string | undefined =>
  names.find(name => name === token) ?? names.find(name => wordListLabel(name, names) === token)

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
