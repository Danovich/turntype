import type { PluginOptions } from 'claude-code'

import type { TypingCountedMode, TypingPicks, TypingSettings } from '../../types'
import { COUNTED_MODES, DEFAULT_COUNTS, DEFAULT_MODE, DEFAULT_WORD_LIST, isCountedMode, isTypingMode } from './modes'
import { isWordListName } from './word-list'

/** The settings before any pick: the defaults of `modes.ts`, adaptive words on. */
export const DEFAULT_SETTINGS: TypingSettings = {
  mode: DEFAULT_MODE,
  counts: DEFAULT_COUNTS,
  isAdaptive: true,
  wordList: DEFAULT_WORD_LIST,
}

/** The store key of the picks: one value, so a pick is one write. */
export const PICKED_SETTINGS_KEY = 'settings'

/** What a pick saves: the picked fields alone. */
export const picksOf = (settings: TypingSettings): TypingPicks => ({ mode: settings.mode, counts: settings.counts, wordList: settings.wordList })

/** The settings in use: the picks over the defaults, or the defaults alone. */
export const settingsInUse = (defaults: TypingSettings, picks: TypingPicks | null): TypingSettings =>
  picks === null ? defaults : { ...defaults, ...picks }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const parseCount = (value: unknown, fallback: number): number => {
  const count = Number(value)

  return Number.isInteger(count) && count > 0 ? count : fallback
}

/** Picks saved before counts were kept per mode named each count by its field. */
const LEGACY_COUNT_FIELDS: Readonly<Record<TypingCountedMode, string>> = { time: 'timeSeconds', words: 'wordCount' }

/** Picks read back from the store: null when none are saved; a field missing or odd keeps its default. */
export const parseSavedPicks = (saved: unknown, defaults: TypingSettings): TypingPicks | null => {
  if (!isRecord(saved)) {
    return null
  }
  const counts = isRecord(saved['counts']) ? saved['counts'] : {}

  return {
    mode: isTypingMode(saved['mode']) ? saved['mode'] : defaults.mode,
    counts: Object.fromEntries(
      COUNTED_MODES.map(mode => [mode, parseCount(counts[mode] ?? saved[LEGACY_COUNT_FIELDS[mode]], defaults.counts[mode])]),
    ) as TypingPicks['counts'],
    wordList: typeof saved['wordList'] === 'string' && isWordListName(saved['wordList']) ? saved['wordList'] : defaults.wordList,
  }
}

/** The defaults before any pick, with adaptive words from /config: the one setting the game has no button for. */
export const parseTypingSettings = (options: PluginOptions): TypingSettings => ({ ...DEFAULT_SETTINGS, isAdaptive: options['adaptive'] !== 'off' })

/** The count a settings' mode is played with: its count, or none for a mode without one (flow). */
export const countOf = (settings: TypingSettings): number | undefined =>
  isCountedMode(settings.mode) ? settings.counts[settings.mode] : undefined

/** The daily goal from /config, in minutes of typing; undefined when off. */
export const parseDailyGoalMinutes = (options: PluginOptions): number | undefined => {
  const minutes = Number(options['dailyGoal'])

  return Number.isInteger(minutes) && minutes > 0 ? minutes : undefined
}
