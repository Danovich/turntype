import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneOpenArgs, Register, Timer, UiOpenResult } from 'claude-code'

import type { TypingDayStanding, TypingGame, TypingPicks, TypingRound, TypingRoundFinished, TypingRoundReady, TypingSettings } from '../types'
import { bandKind, isActive, keepsRound, readableGame, roundAfter } from './engine/lifecycle'
import type { RoundNeed } from './engine/lifecycle'
import { DEFAULT_WORD_LIST } from './engine/modes'
import {
  configKey,
  dayStanding,
  LEGACY_PROGRESS_KEY,
  milestonesReached,
  PART_PARSERS,
  parseLegacyProgress,
  personalBestWpms,
  PROGRESS_PARTS,
  recordResult,
  todayPractice,
  weakBigrams,
} from './engine/progress'
import type { ProgressPart, StoredProgress } from './engine/progress'
import { applyFieldInput, fieldKey, gameWith } from './engine/field'
import type { FieldAsDrawn } from './engine/field'
import { createRound, expireRound, finishByPlayer } from './engine/round'
import { DEFAULT_SETTINGS, parseDailyGoalMinutes, parseSavedPicks, parseTypingSettings, PICKED_SETTINGS_KEY, picksOf, settingsInUse } from './engine/settings'
import { isIdle, isTimeUp } from './engine/timing'
import { FALLBACK_WORD_LIST, isWordListName, parseWordList } from './engine/word-list'
import type { WordList } from './engine/word-list'
import { backToTypingBand, invitationBand, resultBand } from './view/band'
import { gameView } from './view/game'
import { paletteFor, THEME_PALETTE } from './view/palette'
import type { Palette } from './view/palette'
import type { OpenOptions, PickerActions, PickerProps } from './view/picker'
import { resultCard } from './view/result-card'
import { resultToast } from './view/shared'

/*
 * The shell: everything that reaches outside through `$` (state, the store, files, timers, the
 * pane and its keys), applying the pure rules of `engine/` and drawing with `view/`. One file by
 * the platform's rule: `$` and the state atoms never cross an import. Sections, in the order each
 * builds on the one before: state, resources, settings, progress, rounds, pane and focus, session,
 * toolbar, hooks.
 */

type Dollar = EngineInterface

// ─── State ───────────────────────────────────────────────────────────────────────────────────
// The session's values in $.state, declared in types/index.d.ts. A write redraws what read them.

const NO_PICKS: TypingPicks | null = null
const picksAtom = atom({ plugin: 'turntype', key: 'picks' } as const, NO_PICKS)
const NO_GAME: TypingGame | null = null
const gameAtom = atom({ plugin: 'turntype', key: 'game' } as const, NO_GAME)
const clockTickAtom = atom({ plugin: 'turntype', key: 'clockTick' } as const, 0)
const isGameOpenAtom = atom({ plugin: 'turntype', key: 'isGameOpen' } as const, false)
const isPaneFocusedAtom = atom({ plugin: 'turntype', key: 'isPaneFocused' } as const, true)
const isDetailsShownAtom = atom({ plugin: 'turntype', key: 'isDetailsShown' } as const, false)
const NO_OPEN_OPTIONS: OpenOptions = null
const openOptionsAtom = atom({ plugin: 'turntype', key: 'openOptions' } as const, NO_OPEN_OPTIONS)
const NO_PERSONAL_BESTS: Readonly<Record<string, number>> = {}
const personalBestsAtom = atom({ plugin: 'turntype', key: 'personalBests' } as const, NO_PERSONAL_BESTS)
const NO_BIGRAMS: readonly string[] = []
const focusBigramsAtom = atom({ plugin: 'turntype', key: 'focusBigrams' } as const, NO_BIGRAMS)
const NO_DAY_STANDING: TypingDayStanding | null = null
const dayStandingAtom = atom({ plugin: 'turntype', key: 'dayStanding' } as const, NO_DAY_STANDING)

// ─── Resources ───────────────────────────────────────────────────────────────────────────────
// The word lists (files of the mod) and the colors of the Claude Code theme. Module variables, not
// $.state: a key and a redraw read them with no host call, and $.state would copy every list across
// the host boundary on each read. A reload reads them again.

const WORD_LISTS_FOLDER = 'word-lists'
const JSON_EXTENSION = '.json'
const THEME_CONFIG_KEY = 'theme'

// The lists the toolbar names: every `*.json` in word-lists/, by file name, read at start. English
// is always one: without its file the built-in list stands in.
let listNames: readonly string[] = [DEFAULT_WORD_LIST]
// The lists read so far. A file is read the first time its list is needed (the one in use at start,
// or a pick), then kept: a start reads one file, not every list.
let wordLists: ReadonlyMap<string, WordList> = new Map()
// A new theme shows from the next redraw.
let palette: Palette = THEME_PALETTE

/** The list by name, once read; one not read (or gone) gets English, its file's or the built-in one. */
const wordListFor = (name: string): WordList => wordLists.get(name) ?? wordLists.get(DEFAULT_WORD_LIST) ?? FALLBACK_WORD_LIST

const listFolder = (dollar: Dollar): string => `${dollar.plugin.root}/${WORD_LISTS_FOLDER}`

/** Names the lists in word-lists/, from the folder alone: no file is read. Without the folder, English alone. */
const loadListNames = async (dollar: Dollar): Promise<void> => {
  try {
    const names = (await dollar.fs.list(listFolder(dollar)))
      .filter(entry => entry.kind === 'file' && entry.name.endsWith(JSON_EXTENSION))
      .map(entry => entry.name.slice(0, -JSON_EXTENSION.length))
      .filter(isWordListName)
    listNames = [...new Set([DEFAULT_WORD_LIST, ...names])]
  } catch {
    listNames = [DEFAULT_WORD_LIST]
  }
  // A reload reads the files again: one changed since is read as it is now.
  wordLists = new Map()
}

/**
 * Reads list `name` if it is not read yet. False when it cannot be had: no such list, or a file that
 * is not JSON text or not a valid list, which then leaves the toolbar. English always can: without
 * its file, the built-in list.
 */
const ensureList = async (dollar: Dollar, name: string): Promise<boolean> => {
  if (wordLists.has(name)) {
    return true
  }
  const list = listNames.includes(name) ? await readWordList(dollar, name) : undefined
  if (list !== undefined) {
    wordLists = new Map([...wordLists, [name, list]])

    return true
  }
  if (name === DEFAULT_WORD_LIST) {
    // Read once, broken or missing: the built-in English stands in from now on.
    wordLists = new Map([...wordLists, [name, FALLBACK_WORD_LIST]])

    return true
  }
  listNames = listNames.filter(listName => listName !== name)

  return false
}

/** Reads one list file; a file that is not JSON text or not a valid list is none. */
const readWordList = async (dollar: Dollar, name: string): Promise<WordList | undefined> => {
  try {
    const content = await dollar.fs.read(`${listFolder(dollar)}/${name}${JSON_EXTENSION}`)

    return typeof content === 'string' ? parseWordList(name, JSON.parse(content)) : undefined
  } catch {
    return undefined
  }
}

/** Reads the Claude Code theme from /config; without it (an old host, a test) the theme keys stay. */
const loadPalette = async (dollar: Dollar): Promise<void> => {
  try {
    const theme = (await dollar.config.list()).find(row => row.key === THEME_CONFIG_KEY)?.value
    palette = paletteFor(typeof theme === 'string' ? theme : '')
  } catch {
    palette = THEME_PALETTE
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────────────────────
// Two owners: the defaults (the mode table, adaptive from /config) and the picks made in the game
// (the store, copied into state). The settings in use are derived from them, never stored a third time.

// Adaptive comes from /config: a change there reloads the module, and register reads it again.
let defaultSettings: TypingSettings = DEFAULT_SETTINGS
// The daily goal in minutes, from /config the same way; undefined: off.
let dailyGoalMinutes: number | undefined

/** The settings in use: the picks over the defaults. */
const readSettings = async (dollar: Dollar): Promise<TypingSettings> =>
  settingsInUse(defaultSettings, await read(dollar, picksAtom), name => listNames.includes(name))

/** Copies the saved picks into state, where a drawing reads them. At start and after /clear. */
const loadPicks = async (dollar: Dollar): Promise<void> => {
  try {
    const picks = parseSavedPicks(await dollar.store.get(PICKED_SETTINGS_KEY), defaultSettings)
    await update(dollar, picksAtom, () => picks)
  } catch {
    // No store: the defaults alone.
  }
}

/** A pick: in use at once, and saved for the next session and every other one (one store write; nothing reloads). */
const savePicks = async (dollar: Dollar, chosen: TypingSettings): Promise<void> => {
  await update(dollar, picksAtom, () => picksOf(chosen))
  try {
    await dollar.store.set(PICKED_SETTINGS_KEY, picksOf(chosen))
  } catch {
    // Not saved: the pick still holds for this session.
  }
}

// ─── Progress ────────────────────────────────────────────────────────────────────────────────
// The results in the store, one key per part, shared by every session on the machine. A save reads
// every part right before writing it and merges the test in, so a test another session saved is kept.

/** Keeps in state what a key, a new round or the band reads: the personal bests, the weak letter pairs, today. */
const publishProgress = async (dollar: Dollar, progress: StoredProgress): Promise<void> => {
  await Promise.all([
    update(dollar, personalBestsAtom, () => personalBestWpms(progress)),
    update(dollar, focusBigramsAtom, () => weakBigrams(progress)),
    update(dollar, dayStandingAtom, () => dayStanding(progress.daily, Date.now())),
  ])
}

/** Reads the saved parts, all at once; a missing or broken one is empty. */
const readParts = async (dollar: Dollar): Promise<StoredProgress> => {
  const [personalBests, history, daily, bigrams] = await Promise.all(PROGRESS_PARTS.map(part => dollar.store.get(part)))

  return {
    personalBests: PART_PARSERS.personalBests(personalBests),
    history: PART_PARSERS.history(history),
    daily: PART_PARSERS.daily(daily),
    bigrams: PART_PARSERS.bigrams(bigrams),
  }
}

/**
 * Reads the saved parts at load. The one record of versions before 0.8 is split into parts no
 * session has written yet, then deleted: once, and it never replaces a newer part.
 */
const loadParts = async (dollar: Dollar): Promise<StoredProgress> => {
  const [legacyValue, saved] = await Promise.all([dollar.store.get(LEGACY_PROGRESS_KEY), readParts(dollar)])

  if (legacyValue === undefined) {
    return saved
  }
  const legacy = parseLegacyProgress(legacyValue)
  const savedKeys = new Set(await dollar.store.keys())
  const missing = PROGRESS_PARTS.filter(part => !savedKeys.has(part))
  await Promise.all(missing.map(part => dollar.store.set(part, legacy[part])))
  await dollar.store.delete(LEGACY_PROGRESS_KEY)

  const kept = <P extends ProgressPart>(part: P): StoredProgress[P] => (missing.includes(part) ? legacy[part] : saved[part])

  return { personalBests: kept('personalBests'), history: kept('history'), daily: kept('daily'), bigrams: kept('bigrams') }
}

/** Copies the saved progress into state. At start and after /clear. */
const loadProgress = async (dollar: Dollar): Promise<void> => {
  try {
    await publishProgress(dollar, await loadParts(dollar))
  } catch {
    // No store (an old host, a test without one): play on without personal bests.
  }
}

/**
 * Saves a finished test, then attaches its summary to the round for the result card. Each part is
 * read once, all at once, right before the save: the summary compares with that, and the test is
 * merged into it, never written over it, so a test another session saved meanwhile is kept. Then
 * all four are written at once. When the store fails the card shows the result alone.
 */
const recordProgress = async (dollar: Dollar, round: TypingRoundFinished): Promise<void> => {
  try {
    const now = Date.now()
    const before = await readParts(dollar)
    const { progress: after, summary } = recordResult(before, round, now)
    await Promise.all(PROGRESS_PARTS.map(part => dollar.store.set(part, after[part])))
    await Promise.all([
      publishProgress(dollar, after),
      update(dollar, gameAtom, game =>
        game?.round.phase === 'finished' && game.round.roundId === round.roundId ? { ...game, round: { ...game.round, progress: summary } } : game,
      ),
    ])
    const toast = resultToast(round, summary, milestonesReached(before, after, now))
    if (toast !== undefined) {
      dollar.ui.toast(toast)
    }
  } catch {
    // The result card stays without its progress line.
  }
}

// ─── Rounds ──────────────────────────────────────────────────────────────────────────────────
// Every change of the round goes through `replaceGame`: the engine's reducers applied to the round
// and its field in state, the clock run while a test runs, a test saved the moment it finishes.

/** The round in play, if any. */
const readRound = async (dollar: Dollar): Promise<TypingRound | null> => (await read(dollar, gameAtom))?.round ?? null

const TICK_MS = 1000

// A hot reload cancels the timer with the old environment.
let ticker: Timer | undefined

const stopTicker = (): void => {
  ticker?.cancel()
  ticker = undefined
}

/**
 * Each second of a running test: end a time test whose time is up, redraw the clock, and
 * stop while the player is idle (the next key starts it again), so an idle game costs nothing.
 * The round is only read: written only when the time ran out, through replaceRound, which saves it.
 */
const handleTick = async (dollar: Dollar): Promise<void> => {
  const now = Date.now()
  const round = await readRound(dollar)

  if (round?.phase === 'running' && isTimeUp(round, now)) {
    await replaceRound(dollar, current => (current === null ? null : expireRound(current, now)))

    return
  }
  if (round?.phase !== 'running' || isIdle(round, now)) {
    stopTicker()
  }
  await update(dollar, clockTickAtom, tick => tick + 1)
}

const syncTicker = (dollar: Dollar, round: TypingRound | null): void => {
  if (round?.phase !== 'running') {
    stopTicker()
  } else if (ticker === undefined) {
    ticker = dollar.clock.every(TICK_MS, () => void handleTick(dollar))
  }
}

/**
 * The one place a round changes: it runs the clock, and saves a test the moment it finishes. The
 * save follows the change to finished, seen inside the one update: a later update of a finished
 * round (its summary attached, a turn's end) never saves it again.
 */
const replaceGame = async (dollar: Dollar, change: (game: TypingGame | null) => TypingGame | null): Promise<void> => {
  let wasFinished = false
  const game = await update(dollar, gameAtom, current => {
    wasFinished = current?.round.phase === 'finished'

    return change(current)
  })
  const round = game?.round ?? null
  syncTicker(dollar, round)

  if (round?.phase === 'finished' && !wasFinished) {
    await recordProgress(dollar, round)
  }
}

/** A change of the round alone: its field stays while it is the same round, a new round starts with its first field. */
const replaceRound = (dollar: Dollar, change: (round: TypingRound | null) => TypingRound | null): Promise<void> =>
  replaceGame(dollar, game => gameWith(game, change(game?.round ?? null)))

/** One change of a field, as it was drawn. Date.now() here, not $.clock.now(): one host call less on every key. */
const handleInput = (dollar: Dollar, drawn: FieldAsDrawn, fieldText: string, lineWidth: number): void => {
  const now = Date.now()

  void replaceGame(dollar, game =>
    game !== null && isActive(game.round)
      ? applyFieldInput(game, drawn, fieldText, now, { words: wordListFor(game.round.wordList).words, lineWidth })
      : game,
  )
}

/** Enter in the field: the player ends the test. */
const handleFinish = (dollar: Dollar, roundId: number): void => {
  void replaceRound(dollar, round => (round?.phase === 'running' && round.roundId === roundId ? finishByPlayer(round) : round))
}

const nextRoundId = (round: TypingRound | null): number => (round?.roundId ?? 0) + 1

/**
 * Makes rounds with `given` (else the settings in use), the weak letter pairs and the personal
 * best, read once here: the change itself stays synchronous, and a round carries its personal best
 * so a key reads nothing else.
 */
const roundMaker = async (dollar: Dollar, given?: TypingSettings) => {
  const chosen = given ?? (await readSettings(dollar))
  // Read before the change, which stays synchronous; a list that cannot be read gives English.
  await ensureList(dollar, chosen.wordList)
  const weak = await read(dollar, focusBigramsAtom)
  const personalBests = await read(dollar, personalBestsAtom)

  return (previous: TypingRound | null): TypingRoundReady => {
    const round = createRound(nextRoundId(previous), chosen, weak, wordListFor(chosen.wordList))

    return { ...round, pbWpm: personalBests[configKey(round)] }
  }
}

/**
 * A round for `need`: the one there when it serves (keepsRound), else a new one made with `given`
 * or the settings in use. A round that serves needs nothing read or written; the check runs again
 * inside the update, so a round that changed meanwhile is still judged as it is then.
 */
const ensureRound = async (dollar: Dollar, need: RoundNeed, given?: TypingSettings): Promise<void> => {
  if (keepsRound(await readRound(dollar), need)) {
    return
  }
  const makeRound = await roundMaker(dollar, given)
  await replaceRound(dollar, round => (keepsRound(round, need) ? round : makeRound(round)))
}

// ─── Pane and focus ──────────────────────────────────────────────────────────────────────────
// Opening and closing the game pane, the flags the band reads (open, focused), getting the keys
// back after a permission dialog, and handing them to the field after a pick.

const GAME_PANE_ID = 'turntype'
/** Every phase draws exactly this many rows, an empty row between each two, so the pane never changes height. */
const GAME_PANE_ROWS = 9
const GAME_PANE: PaneOpenArgs = { id: GAME_PANE_ID, title: 'turntype', focus: true, closeOnEscape: true, rows: GAME_PANE_ROWS }
/** After a permission ask: how often to look whether the dialog gave the keys back. */
const REFOCUS_POLL_MS = 400
/** A mode that allows the call shows no dialog: if the pane keeps the keys this long, stop looking. */
const REFOCUS_DIALOG_WAIT_MS = 3000
const REFOCUS_GIVE_UP_MS = 60_000

// A hot reload cancels the timer with the old environment.
let refocusTimer: Timer | undefined

const findGamePane = async (dollar: Dollar) => (await dollar.ui.panes()).find(pane => pane.id === GAME_PANE_ID)

/** Writes the focus flag only on a change, so the band is not drawn again for nothing. */
const setPaneFocused = async (dollar: Dollar, isFocused: boolean): Promise<void> => {
  if ((await read(dollar, isPaneFocusedAtom)) !== isFocused) {
    await update(dollar, isPaneFocusedAtom, () => isFocused)
  }
}

/**
 * Opens the game pane with the keyboard; keeps a round in progress, else starts one.
 * Says whether the pane is drawn: where nothing draws (the VS Code chat panel, `claude -p`) it is not.
 */
const openGame = async (dollar: Dollar): Promise<UiOpenResult> => {
  await ensureRound(dollar, 'open')
  await update(dollar, isGameOpenAtom, () => true)
  const opened = await dollar.ui.open(GAME_PANE)
  // Focus is a request: text in the composer refuses it, and then the band keeps its way back.
  await setPaneFocused(dollar, (await findGamePane(dollar))?.isFocused ?? false)

  return opened
}

const stopRefocus = (): void => {
  refocusTimer?.cancel()
  refocusTimer = undefined
}

/**
 * A permission dialog takes the keys from the game and hands them to the prompt when it closes.
 * Watch for that loss, then ask for the keys back until the pane has them: the engine grants it
 * only over an empty composer, so a prompt the person started to write keeps the keys.
 */
const refocusAfterAsk = (dollar: Dollar): void => {
  stopRefocus()
  // Counted in polls, the timer's own time: no second clock to disagree with it.
  let waitedMs = 0
  let hasLostFocus = false

  const check = async (): Promise<void> => {
    waitedMs += REFOCUS_POLL_MS
    const pane = await findGamePane(dollar)

    if (pane === undefined || waitedMs > REFOCUS_GIVE_UP_MS) {
      stopRefocus()
    } else if (pane.isFocused) {
      if (hasLostFocus || waitedMs > REFOCUS_DIALOG_WAIT_MS) {
        stopRefocus()
      }
      await setPaneFocused(dollar, true)
    } else {
      hasLostFocus = true
      await setPaneFocused(dollar, false)
      await dollar.ui.open(GAME_PANE)
    }
  }

  refocusTimer = dollar.clock.every(REFOCUS_POLL_MS, () => void check())
}

// The mod's own $.ui.close does not reach its own ui.close hook, so reset the flag here too.
const closeGame = async (dollar: Dollar): Promise<void> => {
  stopRefocus()
  await replaceRound(dollar, () => null)
  await update(dollar, isGameOpenAtom, () => false)
  await dollar.ui.close({ id: GAME_PANE_ID })
}

/**
 * The new round's field takes the keys: the button just pressed is gone from the toolbar, and the
 * next thing to do is type. Refused (the pane does not hold the keys), the focus stays as it is.
 */
const focusField = async (dollar: Dollar): Promise<void> => {
  const game = await read(dollar, gameAtom)

  if (game !== null && isActive(game.round)) {
    try {
      await dollar.ui.focus({ requestId: GAME_PANE_ID, key: fieldKey(game.field) })
    } catch {
      // No focus call (an old host): the pick still holds; Tab or a click reaches the field.
    }
  }
}

// ─── Session ─────────────────────────────────────────────────────────────────────────────────

/**
 * Copies what the store keeps into $.state and matches the pane flags to the engine's own record.
 * Runs at session start, after a reload, and after /clear, /resume and /branch: those reset every
 * $.state value to its default, but session.start does not fire again.
 */
const syncSession = async (dollar: Dollar): Promise<void> => {
  const [pane] = await Promise.all([findGamePane(dollar), loadPicks(dollar), loadProgress(dollar)])
  await Promise.all([
    update(dollar, isGameOpenAtom, () => pane !== undefined),
    setPaneFocused(dollar, pane?.isFocused ?? true),
    // A reload keeps the round, but one made by a version with another round shape cannot be read.
    update(dollar, gameAtom, readableGame),
  ])

  // A reload keeps the round; a reset leaves none, and an open pane would stay empty.
  if (pane !== undefined && (await read(dollar, gameAtom)) === null) {
    await closeGame(dollar)
  }
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────────────────────

/** A pick in the pane: in use and saved at once, a round not yet started made again with it, the options closed, the keys to the field. */
const chooseSettings = async (dollar: Dollar, chosen: TypingSettings): Promise<void> => {
  // A list read for the first time here; one whose file is broken is said so, and the pick not made.
  if (!(await ensureList(dollar, chosen.wordList))) {
    dollar.ui.toast(`couldn't read the list ${chosen.wordList}: its file is not a word list`)
    await update(dollar, openOptionsAtom, () => null)
    // The list left the toolbar, a module variable: the pane draws again without it.
    dollar.ui.invalidate('ui.render')

    return
  }
  await savePicks(dollar, chosen)
  await ensureRound(dollar, 'settings', chosen)
  await update(dollar, openOptionsAtom, () => null)
  await focusField(dollar)
}

/** The toolbar as the pane draws it: the settings in use, the lists, which group is open. */
const pickerProps = async (dollar: Dollar): Promise<PickerProps> => ({
  settings: await readSettings(dollar),
  wordListNames: listNames,
  palette,
  openOptions: await read(dollar, openOptionsAtom),
})

const pickerActions = (dollar: Dollar): PickerActions => ({
  onChoose: chosen => void chooseSettings(dollar, chosen),
  onToggle: group => void update(dollar, openOptionsAtom, open => (open === group ? null : group)),
})

// ─── Hooks ───────────────────────────────────────────────────────────────────────────────────

/** A turn shorter than this never shows the invitation. */
const APPEAR_AFTER_MS = 3000

// The main agent's turn in progress, if any: an untouched round stays while it runs.
let pendingTurnId: string | undefined

export const register: Register = (on, options) => {
  defaultSettings = parseTypingSettings(options)
  dailyGoalMinutes = parseDailyGoalMinutes(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Everything at once: none of these waits for another, so a start (and every reload, as after a
    // change in /config) takes one round of host calls, not one after another.
    await Promise.all([
      // A refused name throws: caught, so the rest still loads.
      $.command.register({ name: 'type', description: 'Type while Claude works: open the turntype game', immediate: true }).catch(() => undefined),
      loadListNames($),
      loadPalette($),
      syncSession($),
    ])
    // The one list file a start reads: the list in use, known once the picks are.
    await ensureList($, (await readSettings($)).wordList)
    // Lists and colors are module variables, not state: a pane drawn before they were read (a
    // reload draws the open pane at once) is drawn again with them.
    $.ui.invalidate('ui.render')

    return result
  })

  // A new theme in /config: the colors follow from the next redraw.
  on('config.set', { key: THEME_CONFIG_KEY }, async ($, e, next) => {
    const result = await next(e)
    palette = paletteFor(typeof e.value === 'string' ? e.value : '')

    return result
  }).catch(($, e, next) => next(e))

  // /clear, /resume and /branch reset $.state without a new session.start: load and match again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const result = await next(e)
    await syncSession($)

    return result
  }).catch(($, e, next) => next(e))

  // `/type` opens the game; its toolbar changes the settings. Where nothing draws, say so: an empty
  // answer would look like a command that did nothing.
  on('command.run', { command: 'type' }, async $ => {
    const opened = await openGame($)

    return opened.isPlaced ? {} : { text: `the game needs the terminal or the Desktop app (${opened.reason})` }
  })

  // Each .catch passes the event on: in a handler next is replay-safe, so a hook that failed after
  // its next(e) keeps that result and nothing beneath runs twice.
  on('ui.close', { id: GAME_PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    stopRefocus()
    await update($, isGameOpenAtom, () => false)
    await replaceRound($, round => roundAfter(round, { kind: 'paneClosed', isTurnRunning: pendingTurnId !== undefined }))

    return result
  }).catch(($, e, next) => next(e))

  // The field's autoFocus takes the ring whenever the pane takes the keyboard: a click, ctrl+x tab, an open.
  on('ui.focus', { requestId: GAME_PANE_ID }, async ($, e, next) => {
    const result = await next(e)

    if (result.deny === undefined) {
      await setPaneFocused($, true)
    }

    return result
  }).catch(($, e, next) => next(e))

  // A permission dialog is about to take the keys from a game in play: get them back after it.
  // The verdict is passed on as it came; a failure here only skips the refocus (the band still
  // offers the way back), and the .catch hands on the verdict next(e) settled to.
  on('tool.check', async ($, e, next) => {
    const result = await next(e)

    // A query (no dialog) is harmless here: the pane keeps the keys and the watch stops.
    if (result.decision === 'ask' && isActive(await readRound($)) && (await findGamePane($))?.isFocused) {
      refocusAfterAsk($)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    const turnId = e.turnId
    pendingTurnId = turnId

    // Short turns never show the invitation; a test in progress outlives the turn that started it.
    $.clock.after(APPEAR_AFTER_MS, () => {
      if (pendingTurnId === turnId) {
        void ensureRound($, 'invitation')
      }
    })

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (!e.agentId) {
      pendingTurnId = undefined
      // The person writes the next prompt now: never take the keys from them.
      stopRefocus()
      const isGameOpen = await read($, isGameOpenAtom)
      await replaceRound($, round => roundAfter(round, { kind: 'turnComplete', isGameOpen }))
    }

    return result
  })

  // The band: a one-line invitation, or the way back to an open pane that lost the keys.
  // Its digit hotkey also fires from an empty prompt.
  // Hot path: while the game is open and holds the keys the band is empty, and returns before it
  // reads the round, so it is not subscribed to it and a key never draws it again. The open flag
  // is kept by openGame, closeGame, the ui.close hook and session.start, so no host call here.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const isGameOpen = await read($, isGameOpenAtom)

    if (isGameOpen && (await read($, isPaneFocusedAtom))) {
      return next(e)
    }
    const round = await readRound($)
    const kind = bandKind(round, isGameOpen)

    if (round === null || kind === 'none') {
      return next(e)
    }
    const elements = $.ui.resolve(e)
    const openFromBand = () => void openGame($)

    if (round.phase === 'finished') {
      return resultBand(elements, round, palette, openFromBand)
    }

    if (kind === 'back') {
      return backToTypingBand(elements, round, openFromBand)
    }
    // Only the invitation shows today: a test waiting to continue is not subscribed to it.
    const standing = round.phase === 'ready' ? await read($, dayStandingAtom) : null
    const daily = standing === null ? undefined : { practice: todayPractice(standing, Date.now()), goalMinutes: dailyGoalMinutes }

    return invitationBand(elements, round, daily, openFromBand)
  })

  // The game pane: nine rows in every phase. Words, the field and live stats, then the toolbar
  // before the first key; or the result card.
  on('ui.render', { component: 'Pane', requestId: GAME_PANE_ID }, async ($, e, next) => {
    const game = await read($, gameAtom)
    const elements = $.ui.resolve(e)

    if (game === null || !('Input' in elements)) {
      return next(e)
    }
    const { round, field } = game

    if (round.phase === 'finished') {
      return resultCard(
        elements,
        round,
        { isTerminal: e.surface === 'terminal', isDetailsShown: await read($, isDetailsShownAtom), palette, picker: await pickerProps($) },
        {
          onAgain: () => void ensureRound($, 'again'),
          onClose: () => void closeGame($),
          onToggleDetails: () => void update($, isDetailsShownAtom, isShown => !isShown),
          picker: pickerActions($),
        },
      )
    }

    // Subscribes the pane to the ticker while a test runs.
    if (round.phase === 'running') {
      await read($, clockTickAtom)
    }

    return gameView(
      elements,
      round,
      field,
      {
        bodyColumns: e.props.bodyColumns,
        isFocused: e.props.isFocused,
        now: Date.now(),
        palette,
        // Only before the first key, where the toolbar is drawn: a key never reads the settings.
        picker: round.phase === 'ready' ? await pickerProps($) : undefined,
      },
      {
        onInput: (drawn, text, lineWidth) => handleInput($, drawn, text, lineWidth),
        onFinish: roundId => handleFinish($, roundId),
        picker: pickerActions($),
      },
    )
  })
}
