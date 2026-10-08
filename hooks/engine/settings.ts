import type { PluginOptions } from 'claude-code'

import type { TypingMode, TypingSettings } from '../../types'
import { DEFAULT_WORD_LIST_NAME, findWordListName, isWordListName } from './word-list'

export const TYPING_MODE = {
  flow: 'flow',
  words: 'words',
  time: 'time',
} as const satisfies Record<TypingMode, TypingMode>

export const DEFAULT_SETTINGS: TypingSettings = {
  mode: TYPING_MODE.flow,
  wordCount: 25,
  timeSeconds: 30,
  isAdaptive: true,
  wordList: DEFAULT_WORD_LIST_NAME,
}

/** The presets of the in-pane picker; the manifest's userConfig offers the same. */
export const TIME_PRESETS = [15, 30, 60, 120] as const
export const WORD_PRESETS = [10, 25, 50, 100] as const

const isTypingMode = (value: unknown): value is TypingMode =>
  typeof value === 'string' && Object.values(TYPING_MODE).some(mode => mode === value)

/** userConfig presets are strings, so the config menu draws them as a picker. */
const parseCount = (value: unknown, fallback: number): number => {
  const count = Number(value)

  return Number.isInteger(count) && count > 0 ? count : fallback
}

/** Reads the manifest's userConfig; a missing or odd value falls back to its default. */
export const parseTypingSettings = (options: PluginOptions): TypingSettings => ({
  mode: isTypingMode(options['mode']) ? options['mode'] : DEFAULT_SETTINGS.mode,
  wordCount: parseCount(options['wordCount'], DEFAULT_SETTINGS.wordCount),
  timeSeconds: parseCount(options['timeSeconds'], DEFAULT_SETTINGS.timeSeconds),
  isAdaptive: options['adaptive'] !== 'off',
  // A name only: whether such a list exists is known once the lists are read.
  wordList: typeof options['wordList'] === 'string' && isWordListName(options['wordList']) ? options['wordList'] : DEFAULT_SETTINGS.wordList,
})

export type TypeCommandResult =
  | { readonly isValid: true; readonly settings: TypingSettings }
  | { readonly isValid: false; readonly error: string }

const isPreset = (presets: readonly number[], value: number): boolean => presets.includes(value)

/**
 * The arguments of `/type`, in any order: a mode (`flow`, `time`, `words`), a count (a time or a
 * words preset; the two never share a number, so a count alone names its mode), a word list by name
 * or toolbar label (`code`, `10k`). Each changes `settings`; anything else is an error naming it.
 */
export const parseTypeArguments = (args: string, settings: TypingSettings, wordListNames: readonly string[]): TypeCommandResult => {
  let chosen = settings

  for (const token of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const count = Number(token)
    const listName = findWordListName(token, wordListNames)

    if (isTypingMode(token)) {
      chosen = { ...chosen, mode: token }
    } else if (isPreset(TIME_PRESETS, count)) {
      chosen = { ...chosen, mode: TYPING_MODE.time, timeSeconds: count }
    } else if (isPreset(WORD_PRESETS, count)) {
      chosen = { ...chosen, mode: TYPING_MODE.words, wordCount: count }
    } else if (listName !== undefined) {
      chosen = { ...chosen, wordList: listName }
    } else {
      return { isValid: false, error: `unknown "${token}"` }
    }
  }

  return { isValid: true, settings: chosen }
}
