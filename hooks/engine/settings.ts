import type { PluginOptions } from 'claude-code'

import type { TypingMode, TypingSettings } from '../../types'
import { DEFAULT_WORD_LIST_NAME, isWordListName } from './word-list'

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
