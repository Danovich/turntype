/**
 * Probe: the whole flow through the engine, and the edge cases around it.
 * Run: claude plugin test <mod folder>
 *
 * Time here is the mocked `$.clock`. The mod reads `Date.now()` for typing speed and for the time
 * limit, so a time test running out and idle pauses are covered by engine.test.ts, not here.
 * The test's `$` raises events, not engine calls: it cannot press Esc on the pane (`ui.close`).
 * Check by hand: Esc during a test keeps it in the band ("continue"); Esc on an untouched
 * round during a turn keeps the invitation until the turn ends.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, PaneOpenArgs } from 'claude-code'

import { FALLBACK_WORD_LIST } from '../hooks/engine/word-list'

const GAME = 'turntype'
const PANE_ROWS = 9

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const PANE_PROPS = {
  title: GAME,
  isFocused: true,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: PANE_ROWS },
  view: {},
}

const EMPTY_SITE = { type: 'Box', props: {} } as const

const TURN_DONE = { reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false } as const

/** /type as the person types it in the prompt. */
/** Saved picks in the store, as a later session finds them: over the defaults (flow, time 30, words 25, english). */
const picks = (change: { mode?: 'flow' | 'time' | 'words'; time?: number; words?: number; wordList?: string }) => ({
  settings: { mode: change.mode ?? 'flow', counts: { time: change.time ?? 30, words: change.words ?? 25 }, wordList: change.wordList ?? 'english' },
})

/** A session start as an interactive terminal session raises it. */
const SESSION = { cwd: '/', surface: 'terminal', isInteractive: true } as const

const TYPE_COMMAND = {
  command: 'type',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

type Verdict = 'allow' | 'ask' | 'deny'

/** The engine beneath the mod, with every switch a probe needs. */
type World = {
  verdict: Verdict
  isPaneFocused: boolean
  /** A permission dialog holds the keys: a focus request is refused. */
  isDialogOpen: boolean
  /** Text in the composer: a focus request is refused. */
  hasComposerText: boolean
  isStoreBroken: boolean
  isPaneListBroken: boolean
  /** False where nothing draws, as in the VS Code chat panel or claude -p. */
  canDraw: boolean
  readonly openPaneIds: Set<string>
  readonly openCalls: PaneOpenArgs[]
  readonly configWrites: { key: string; value: unknown }[]
  readonly toasts: string[]
  /** The store's content: what the mod saved. */
  readonly saved: Map<string, unknown>
  /** Runs before each store read: how a test lets another session write in between. */
  beforeGet: (key: string) => void
  /** The mod's `word-lists/` folder, file name to content; undefined: no such folder. */
  wordListFiles: Readonly<Record<string, string>> | undefined
  /** Every path the mod read with $.fs.read. */
  readonly fileReads: string[]
  /** The Claude Code theme /config holds; undefined: no /config rows at all. */
  theme: string | undefined
}

const focusRequests = (world: World): number => world.openCalls.filter(args => args.focus).length

const stubWorld = (on: On, storeEntries: Readonly<Record<string, unknown>> = {}): World => {
  const world: World = {
    verdict: 'ask',
    isPaneFocused: true,
    isDialogOpen: false,
    hasComposerText: false,
    isStoreBroken: false,
    isPaneListBroken: false,
    canDraw: true,
    openPaneIds: new Set(),
    openCalls: [],
    configWrites: [],
    toasts: [],
    saved: new Map(Object.entries(storeEntries)),
    beforeGet: () => undefined,
    wordListFiles: undefined,
    fileReads: [],
    theme: undefined,
  }
  const savedValues = world.saved

  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.render', () => EMPTY_SITE)
  on('ui.toast', (_, e) => (world.toasts.push(String(e.text)), { value: undefined }))
  on('config.set', (_, e) => (world.configWrites.push({ key: e.key, value: e.value }), { value: e.value }))
  on('config.list', () =>
    world.theme === undefined
      ? { deny: 'no config rows' }
      : {
          value: [
            {
              key: 'theme',
              label: 'Theme',
              kind: 'choice' as const,
              value: world.theme,
              provider: { plugin: 'engine', tier: 'core' as const },
              isLocked: false,
            },
          ],
        },
  )
  on('tool.check', () => ({ decision: world.verdict }))
  on('ui.focus', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('ui.open', (_, e) => {
    world.openCalls.push(e)
    if (!world.canDraw) {
      return { value: { isPlaced: false, reason: 'nothing draws panes here' } }
    }
    world.openPaneIds.add(e.id)
    if (e.focus && !world.isDialogOpen && !world.hasComposerText) {
      world.isPaneFocused = true
    }

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => (world.openPaneIds.delete(e.id), { value: undefined }))
  on('ui.panes', () => {
    if (world.isPaneListBroken) {
      throw new Error('panes down')
    }

    return {
      value: [...world.openPaneIds].map(id => ({ id, title: id, isShown: true, isFocused: world.isPaneFocused, isPlaced: true })),
    }
  })
  on('store.get', (_, e) => {
    if (world.isStoreBroken) {
      throw new Error('store down')
    }
    world.beforeGet(e.key)

    return { value: savedValues.get(e.key) }
  })
  on('store.set', (_, e) => {
    if (world.isStoreBroken) {
      throw new Error('store down')
    }
    savedValues.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...savedValues.keys()] }))
  on('fs.list', (_, e) =>
    world.wordListFiles !== undefined && e.path.endsWith('/word-lists')
      ? { value: Object.keys(world.wordListFiles).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
      : { deny: 'no such directory' },
  )
  on('fs.read', (_, e) => {
    world.fileReads.push(e.path)
    const content = world.wordListFiles?.[e.path.split('/').at(-1) ?? '']

    return content === undefined ? { deny: 'no such file' } : { value: content }
  })
  on('store.delete', (_, e) => (savedValues.delete(e.key), { value: undefined }))

  return world
}

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && 'type' in value

const childrenOf = (node: Node): unknown[] => {
  const fromProps = node.props?.['children']

  return node.children ?? (Array.isArray(fromProps) ? fromProps : fromProps === undefined ? [] : [fromProps])
}

/** Rows a drawing takes when nothing wraps: a column adds its children and the gaps between them, a row takes its tallest. */
const rowCount = (node: unknown): number => {
  if (!isNode(node)) {
    return 0
  }
  if (node.type !== 'Box') {
    return 1
  }
  const childRows = childrenOf(node).flat().map(rowCount)

  if (childRows.length === 0) {
    return 0
  }

  const rowGap = typeof node.props?.['rowGap'] === 'number' ? node.props['rowGap'] : 0

  return node.props?.['flexDirection'] === 'column'
    ? childRows.reduce((sum, rows) => sum + rows, 0) + rowGap * (childRows.length - 1)
    : Math.max(...childRows)
}

type Surface = 'terminal' | 'desktop'
type PaneHandle = Mounted<Surface, 'Pane'>

/** The field on show, as the person sees it: its key says the round and the field (`r1-f2`). */
const fieldKey = async (pane: PaneHandle): Promise<string | undefined> => (await pane.find({ type: 'Input' }))?.key

/** The word to type next, read off the words rows from the yellow caret on its first letter to the next space. */
const currentWord = async (pane: PaneHandle): Promise<string> => {
  const texts = await pane.findAll({ type: 'Text' })
  const caret = texts.findIndex(found => found.props['inverse'] === true)

  return caret < 0 ? '' : texts.slice(caret).map(found => found.text).join('').split(' ')[0] ?? ''
}

const isFinished = async (pane: PaneHandle): Promise<boolean> => (await pane.find({ type: 'Button', key: 'again' })) !== undefined

/** Types the word at the caret and a space into the field on show, one key per change, as a player does. */
const typeNextWord = async (pane: PaneHandle, mistype = false): Promise<void> => {
  const key = await fieldKey(pane)
  const word = await currentWord(pane)

  if (key === undefined || word === '') {
    throw new Error('no field or no current word on show')
  }
  const text = mistype ? `#${word.slice(1)} ` : `${word} `
  for (let length = 1; length <= text.length; length++) {
    await pane.input({ key, text: text.slice(0, length), kind: 'change' })
    // The last word of a words test ends it at its last letter, before the space.
    if (await isFinished(pane)) {
      return
    }
  }
}

/** Enter in the field on show: the player ends the test. */
const pressEnter = async (pane: PaneHandle): Promise<void> => {
  const key = await fieldKey(pane)

  if (key === undefined) {
    throw new Error('no field on show')
  }
  await pane.input({ key, text: '', kind: 'submit' })
}

/** A turn long enough for the invitation, the game opened from the band: the usual way in. */
const openFromBand = async ($: Engine, clock: ReturnType<typeof mock.clock>, surface: Surface = 'terminal') => {
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await clock.advance(3000)
  const band = await $.ui.mount({ plugin: GAME, surface, component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'play' })
  const pane = await $.ui.mount({ plugin: GAME, surface, component: 'Pane', requestId: GAME, props: PANE_PROPS })

  return { band, pane }
}

/** The picker's selected options: bold yellow text, no longer buttons (`flow`, `time`, `30`, ...). */
const selectedOptions = async (pane: PaneHandle): Promise<string[]> =>
  (await pane.findAll({ type: 'Text' }))
    .filter(found => found.props['bold'] === true && /^(?:\S )?(?:flow|time|words)$|^\d+$/.test(found.text))
    // Without the mode icon: "◷ time" is "time".
    .map(found => found.text.replace(/^\S /, ''))

const expectPaneRows = async (pane: PaneHandle, phase: string): Promise<void> => {
  expect(rowCount(await pane.drawn()), `pane rows while ${phase}`).toBe(PANE_ROWS)
}

describe('probe: the pane never changes height', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: ready, every word, Claude done, finished, details`, async ($, on) => {
      const clock = mock.clock(on)
      stubWorld(on, picks({ mode: 'words', words: 10 }))
      await $.session.start(SESSION)
      const { pane } = await openFromBand($, clock, surface)

      await expectPaneRows(pane, 'ready')
      for (let index = 0; index < 9; index++) {
        await typeNextWord(pane, index === 3)
        await expectPaneRows(pane, `running, word ${index + 1}`)
      }
      await $.turn.complete({ ...TURN_DONE, turnId: 'turn-1' })
      await expectPaneRows(pane, 'running, Claude done')

      await typeNextWord(pane)
      expect(await isFinished(pane)).toBe(true)
      await expectPaneRows(pane, 'finished')
      await pane.press({ key: 'details' })
      await expectPaneRows(pane, 'finished, details shown')
    })
  }

  for (const bodyColumns of [24, 40, 200]) {
    test(`width ${bodyColumns}: the same height, also at the end of a words test`, async ($, on) => {
      const clock = mock.clock(on)
      stubWorld(on, picks({ mode: 'words', words: 10 }))
      await $.session.start(SESSION)
      const { pane } = await openFromBand($, clock)
      await pane.redraw({ ...PANE_PROPS, bodyColumns })

      for (let index = 0; index < 9; index++) {
        await expectPaneRows(pane, `width ${bodyColumns}, word ${index + 1}`)
        await typeNextWord(pane)
      }
      await expectPaneRows(pane, `width ${bodyColumns}, last word`)
    })
  }

  // The kit draws no focus ring, so this holds its cause: a Button drawn before the field that goes
  // at the first key (the toolbar) moved the ring off the field, and the next keys reached the prompt.
  test('the field is drawn before every Button, before the first key and after it', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    const { pane } = await openFromBand($, clock)
    const elementsBeforeField = async (): Promise<string[]> => {
      const types = (await pane.findAll({})).map(found => found.type)

      return types.slice(0, types.indexOf('Input'))
    }

    expect(await pane.find({ type: 'Button' })).toBeDefined()
    expect(await elementsBeforeField()).not.toContain('Button')
    await pane.input({ key: 'r1-f0', text: 'x', kind: 'change' })
    expect(await pane.find({ type: 'Input', key: 'r1-f0' })).toBeDefined()
    expect(await elementsBeforeField()).not.toContain('Button')
  })

  test('a finished test is saved once, however often the finished round changes after', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on, picks({ mode: 'words', words: 10 }))
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)
    for (let index = 0; index < 10; index++) {
      await typeNextWord(pane)
    }
    expect(await isFinished(pane)).toBe(true)

    // The summary attached, Claude's turn ending, details shown: each changes the finished round.
    await $.turn.complete({ ...TURN_DONE, turnId: 'turn-1' })
    await pane.press({ key: 'details' })
    // Saved twice, today's total would count two tests.
    expect(Object.values(world.saved.get('daily') as Record<string, { tests: number }>).map(day => day.tests)).toEqual([1])
  })

  test('a store that fails: the card has no progress line but keeps its height', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    world.isStoreBroken = true
    const { pane } = await openFromBand($, clock)

    await typeNextWord(pane)
    await pressEnter(pane)
    expect(await isFinished(pane)).toBe(true)
    expect(await pane.find({ type: 'Text', text: /personal best/ })).toBeUndefined()
    await expectPaneRows(pane, 'finished without progress')
  })
})

describe('probe: result card', () => {
  test('terminal: wpm in block digits; desktop: plain', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    const { pane } = await openFromBand($, clock, 'terminal')
    await typeNextWord(pane)
    await pressEnter(pane)

    const digitTexts = (await pane.findAll({ type: 'Text', text: /^[█▀▄ ]*[█▀▄][█▀▄ ]*$/ })).map(found => found.text)
    expect(digitTexts.length).toBe(3)
    expect(new Set(digitTexts.map(row => row.length)).size).toBe(1)

    await pane.unmount()
    const desktopPane = await $.ui.mount({ plugin: GAME, surface: 'desktop', component: 'Pane', requestId: GAME, props: PANE_PROPS })
    expect(await desktopPane.find({ type: 'Text', text: /[█▀▄]/ })).toBeUndefined()
    expect(await desktopPane.find({ type: 'Text', text: /^\d+$/ })).toBeDefined()
  })

  test('a corrupt saved record starts fresh; the first fair result is the first personal best', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, { progress: { version: 1, personalBests: 'broken', history: [42], daily: null } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const { pane } = await openFromBand($, clock)

    // Flow needs 15 s of active time to be fair; a words test does not.
    await pane.press({ key: 'pick-words' })
    await pane.press({ key: 'pick-words-25' })
    for (let index = 0; index < 25; index++) {
      await typeNextWord(pane)
    }
    expect(await isFinished(pane)).toBe(true)
    expect(await pane.find({ type: 'Text', text: '✦ first personal best for this test' })).toBeDefined()
  })
})

describe('probe: picker', () => {
  test('a press shows a group\'s options and picks nothing; a pick changes the test, closes them and is saved once', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const { pane } = await openFromBand($, clock)

    await pane.press({ key: 'pick-words' })
    expect(await fieldKey(pane)).toBe('r1-f0')
    expect(world.configWrites).toEqual([])
    await pane.press({ key: 'pick-words-50' })
    expect(await pane.find({ type: 'Button', key: 'pick-words' })).toMatchObject({ props: { label: '☰ words (50)' } })
    expect(await pane.find({ key: 'pick-words-10' })).toBeUndefined()

    await pane.press({ key: 'pick-time' })
    await pane.press({ key: 'pick-time-30' })
    // Words keeps the 50 picked before, shown beside it while time is in use.
    expect(await pane.find({ type: 'Button', key: 'pick-words' })).toMatchObject({ props: { label: '☰ words (50)', dimColor: true } })
    await pane.press({ key: 'pick-flow' })
    // Each pick is a new round: flow was r1, then three picks.
    expect(await fieldKey(pane)).toBe('r4-f0')

    // Saved as one value in the store, the last pick over the others; /config is never written.
    expect(world.saved.get('settings')).toEqual({ mode: 'flow', counts: { time: 30, words: 50 }, wordList: 'english' })
    expect(world.configWrites).toEqual([])
  })

  test('saved picks are in use at the next start', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, picks({ mode: 'words', words: 50 }))
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)

    expect(await pane.find({ type: 'Button', key: 'pick-words' })).toMatchObject({ props: { label: '☰ words (50)' } })
    expect((await pane.find({ type: 'Button', key: 'pick-words' }))?.props['dimColor']).toBe(false)
  })

  test('one group open at a time; a press on the open one closes it and changes nothing', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const { pane } = await openFromBand($, clock)

    await pane.press({ key: 'pick-time' })
    expect(await pane.find({ key: 'pick-time-15' })).toBeDefined()
    await pane.press({ key: 'pick-list' })
    expect(await pane.find({ key: 'pick-time-15' })).toBeUndefined()
    expect(await pane.find({ type: 'Button', key: 'pick-list' })).toMatchObject({ props: { label: 'english' } })
    await pane.press({ key: 'pick-list' })
    expect(await pane.find({ type: 'Button', key: 'pick-list' })).toMatchObject({ props: { label: 'english' } })
    expect(await fieldKey(pane)).toBe('r1-f0')
    expect(world.configWrites).toEqual([])
  })

  test('flow in use: its press closes an open group and changes nothing', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const { pane } = await openFromBand($, clock)

    await pane.press({ key: 'pick-time' })
    expect(await pane.find({ key: 'pick-time-15' })).toBeDefined()
    await pane.press({ key: 'pick-flow' })
    expect(await pane.find({ key: 'pick-time-15' })).toBeUndefined()
    expect(await fieldKey(pane)).toBe('r1-f0')
    expect(world.saved.has('settings')).toBe(false)
  })

  test('in an open group the count in use is yellow text, the others dim buttons', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, picks({ mode: 'time' }))
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)

    await pane.press({ key: 'pick-time' })
    expect(await pane.find({ type: 'Text', text: /^30$/ })).toMatchObject({ props: { color: 'warning', bold: true } })
    expect(await pane.find({ type: 'Button', key: 'pick-time-30' })).toBeUndefined()
    expect(await pane.find({ type: 'Button', key: 'pick-time-60' })).toMatchObject({ props: { dimColor: true } })
  })
})

describe('probe: turns, close and reopen', () => {
  test('"x: close" on the result: the band goes, and the next long turn invites again', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const { band, pane } = await openFromBand($, clock)
    await typeNextWord(pane)
    await pressEnter(pane)
    await pane.press({ key: 'close' })
    expect(world.openPaneIds.has(GAME)).toBe(false)
    expect(await band.find({ type: 'Button' })).toBeUndefined()

    await $.turn.complete({ ...TURN_DONE, turnId: 'turn-1' })
    await $.turn.start({ text: 'next', turnId: 'turn-2' })
    await clock.advance(3000)
    expect(await band.find({ type: 'Button', key: 'play' })).toMatchObject({ props: { label: 'type while you wait' } })
  })

  /** The local day `days` before today, as the store keys it. */
  const daysAgo = (days: number): string => {
    const date = new Date()
    date.setDate(date.getDate() - days)

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const TWO_DAYS_PLAYED = { daily: { [daysAgo(2)]: { tests: 1, activeMs: 60_000 }, [daysAgo(1)]: { tests: 2, activeMs: 120_000 } } }

  /** A turn long enough for the invitation, the band mounted: its dim text beside `press 1:`. */
  const invitationTexts = async ($: Engine, clock: ReturnType<typeof mock.clock>) => {
    await $.session.start(SESSION)
    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await clock.advance(3000)
    const band = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

    return (await band.findAll({ type: 'Text' })).map(found => found.text)
  }

  test("the invitation shows today's goal, and the streak to keep before today's first test", async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, TWO_DAYS_PLAYED)

    expect(await invitationTexts($, clock)).toContain('⋅ 0/5 min today ⋅ keep your 2-day streak')
  })

  test('the goal met: says so with the goal; played today, the streak counts today', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, { daily: { ...TWO_DAYS_PLAYED.daily, [daysAgo(0)]: { tests: 3, activeMs: 330_000 } } })
    const texts = await invitationTexts($, clock)

    expect(texts).toContain('⋅ daily goal met (5 min) ⋅ 3-day streak')
  })

  test('the goal off in /config: the streak alone', { options: { dailyGoal: 'off' } }, async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, TWO_DAYS_PLAYED)

    expect(await invitationTexts($, clock)).toContain('⋅ keep your 2-day streak')
  })

  test('a first day with the goal off: nothing beside the invitation', { options: { dailyGoal: 'off' } }, async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)

    expect(await invitationTexts($, clock)).toEqual(['press'])
  })

  test('"again" twice in a row: each press is one new round, the field always fresh', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    const { pane } = await openFromBand($, clock)
    await typeNextWord(pane)
    await pressEnter(pane)
    await pane.press({ key: 'again' })
    expect(await fieldKey(pane)).toBe('r2-f0')

    await typeNextWord(pane)
    await pressEnter(pane)
    await pane.press({ key: 'again' })
    expect(await fieldKey(pane)).toBe('r3-f0')
  })

  test("a subagent's turn ending is not Claude done; the main turn's is", async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    const { pane } = await openFromBand($, clock)
    await typeNextWord(pane)

    await $.turn.complete({ ...TURN_DONE, turnId: 'sub-1', agentId: 'agent-1' })
    expect(await pane.find({ type: 'Text', text: /Claude is done/ })).toBeUndefined()
    await $.turn.complete({ ...TURN_DONE, turnId: 'turn-1' })
    expect(await pane.find({ type: 'Text', text: '∘ Claude is done ⋅ finish the word' })).toBeDefined()
  })

  test('Claude done in a time test: Enter ends it, not the word', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, picks({ mode: 'time' }))
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)
    await typeNextWord(pane)

    await $.turn.complete({ ...TURN_DONE, turnId: 'turn-1' })
    expect(await pane.find({ type: 'Text', text: '∘ Claude is done ⋅ ⏎ finish' })).toBeDefined()
  })

  test('flow ends at the first space after Claude is done, as a complete test', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    const { pane } = await openFromBand($, clock)
    await typeNextWord(pane)
    await $.turn.complete({ ...TURN_DONE, turnId: 'turn-1' })
    expect(await isFinished(pane)).toBe(false)

    await typeNextWord(pane)
    expect(await isFinished(pane)).toBe(true)
    // Complete, not ended early: only its shortness keeps it from being a personal best.
    expect(await pane.find({ type: 'Text', text: 'not a personal best try: under 15 s' })).toBeDefined()
  })

  test('a survey holds the band: the mod yields', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await clock.advance(3000)
    const band = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey: true } })

    expect(await band.find({ type: 'Button' })).toBeUndefined()
  })

  test('a new turn while a test runs keeps the test, not a fresh invitation', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    const { pane } = await openFromBand($, clock)
    await typeNextWord(pane)
    await $.turn.complete({ ...TURN_DONE, turnId: 'turn-1' })

    await $.turn.start({ text: 'next', turnId: 'turn-2' })
    await clock.advance(3000)
    expect(await fieldKey(pane)).toBe('r1-f1')
  })
})

describe('probe: focus after a permission ask', () => {
  test('the happy path: the dialog takes the keys, the mod gets them back once it closes', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const { band } = await openFromBand($, clock)
    world.openCalls.length = 0

    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    world.isDialogOpen = true
    world.isPaneFocused = false
    await clock.advance(1200)
    expect(world.isPaneFocused).toBe(false)
    expect(await band.find({ type: 'Button', key: 'play' })).toMatchObject({ props: { label: 'back to typing' } })

    world.isDialogOpen = false
    await clock.advance(400)
    expect(world.isPaneFocused).toBe(true)
    await clock.advance(400)
    expect(await band.find({ type: 'Button', key: 'play' })).toBeUndefined()

    // Watch over: a later loss (the person clicks the prompt) is theirs.
    const requestsBefore = focusRequests(world)
    world.isPaneFocused = false
    await clock.advance(5000)
    expect(focusRequests(world)).toBe(requestsBefore)
  })

  test('a mode that allows the call shows no dialog: the watch stops after 3 s and never grabs', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    await openFromBand($, clock)
    world.openCalls.length = 0

    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    await clock.advance(3600)
    world.isPaneFocused = false
    await clock.advance(5000)
    expect(focusRequests(world)).toBe(0)
  })

  test('text in the composer refuses the keys; the band offers the way back; the turn end stops the watch', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const { band } = await openFromBand($, clock)

    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    world.isPaneFocused = false
    world.hasComposerText = true
    await clock.advance(2000)
    expect(world.isPaneFocused).toBe(false)
    expect(await band.find({ type: 'Button', key: 'play' })).toMatchObject({ props: { hotkey: '1' } })

    await $.turn.complete({ ...TURN_DONE, turnId: 'turn-1' })
    world.hasComposerText = false
    world.openCalls.length = 0
    await clock.advance(5000)
    expect(focusRequests(world)).toBe(0)
    expect(world.isPaneFocused).toBe(false)
  })

  test('the watch gives up after 60 s', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    await openFromBand($, clock)

    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    world.isPaneFocused = false
    world.hasComposerText = true
    await clock.advance(61_000)
    world.hasComposerText = false
    world.openCalls.length = 0
    await clock.advance(2000)
    expect(focusRequests(world)).toBe(0)
  })

  test('the pane gone during the watch stops it: the pane is never reopened', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    await openFromBand($, clock)

    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    world.isPaneFocused = false
    world.isDialogOpen = true
    // The engine's record loses the pane, as when the person closes it while the dialog is up.
    world.openPaneIds.delete(GAME)
    await clock.advance(400)
    world.isDialogOpen = false
    world.openCalls.length = 0
    await clock.advance(2000)
    expect(world.openCalls).toEqual([])
    expect(world.openPaneIds.has(GAME)).toBe(false)
  })

  test('no watch when the pane did not hold the keys, or no test is in play', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const { pane } = await openFromBand($, clock)

    world.isPaneFocused = false
    world.openCalls.length = 0
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    await clock.advance(2000)
    expect(focusRequests(world)).toBe(0)

    world.isPaneFocused = true
    await typeNextWord(pane)
    await pressEnter(pane)
    expect(await isFinished(pane)).toBe(true)
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    world.isPaneFocused = false
    await clock.advance(2000)
    expect(focusRequests(world)).toBe(0)
  })

  for (const verdict of ['allow', 'ask', 'deny'] as const) {
    test(`the verdict "${verdict}" passes through unchanged, with a game in play`, async ($, on) => {
      const clock = mock.clock(on)
      const world = stubWorld(on)
      await openFromBand($, clock)
      world.verdict = verdict

      expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf /tmp/x' } })).decision).toBe(verdict)
    })
  }

  test('the verdict passes through even when the pane list fails', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    await openFromBand($, clock)
    world.isPaneListBroken = true
    world.verdict = 'ask'

    expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('ask')
  })

  test('the field taking the ring (a click, ctrl+x tab) puts the band away', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const { band } = await openFromBand($, clock)

    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    world.isPaneFocused = false
    world.hasComposerText = true
    await clock.advance(800)
    expect(await band.find({ type: 'Button', key: 'play' })).toBeDefined()

    world.isPaneFocused = true
    await $.ui.focus({ component: 'Pane', requestId: GAME, element: 'r1-f0', origin: { kind: 'person' } })
    expect(await band.find({ type: 'Button', key: 'play' })).toBeUndefined()
  })

  test('a reload with the pane open but not focused: the band offers the way back', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const { band } = await openFromBand($, clock)

    world.isPaneFocused = false
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(await band.find({ type: 'Button', key: 'play' })).toMatchObject({ props: { label: 'back to typing' } })
  })
})

describe('probe: /clear, /resume and /branch, and where nothing draws', () => {
  // A test starts with every $.state value at its default, as /clear leaves them; session.start is not fired.
  const WEAK_PAIRS_PROGRESS = {
    progress: {
      version: 1,
      personalBests: {},
      history: [],
      daily: {},
      bigrams: { th: { attempts: 40, errors: 10 }, he: { attempts: 30, errors: 6 } },
    },
  }

  test('after /clear the saved weak letter pairs are loaded again', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, WEAK_PAIRS_PROGRESS)

    await $.classic.SessionStart({ source: 'clear' })
    const { pane } = await openFromBand($, clock)
    expect(await pane.find({ type: 'Text', text: 'your weak pairs: th he' })).toBeDefined()
  })

  test('a start after compaction does not load again: only clear, resume and fork', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, WEAK_PAIRS_PROGRESS)

    await $.classic.SessionStart({ source: 'compact' })
    const { pane } = await openFromBand($, clock)
    expect(await pane.find({ type: 'Input' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /your weak pairs/ })).toBeUndefined()
  })

  test('after /clear a pane left open with no round is closed, not left empty', async ($, on) => {
    const world = stubWorld(on)
    world.openPaneIds.add(GAME)

    await $.classic.SessionStart({ source: 'clear' })
    expect(world.openPaneIds.has(GAME)).toBe(false)
    const band = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Button' })).toBeUndefined()
  })

  test('/type where nothing draws answers with the reason, not silence', async ($, on) => {
    const world = stubWorld(on)
    world.canDraw = false

    const answer = await $.command.run(TYPE_COMMAND)
    expect(answer).toMatchObject({ text: 'the game needs the terminal or the Desktop app (nothing draws panes here)' })
  })

  test('/type where the pane draws prints nothing', async ($, on) => {
    stubWorld(on)

    expect(await $.command.run(TYPE_COMMAND)).toEqual({})
  })
})

describe('probe: symbols', () => {
  // An emoji-capable symbol (such as U+2328) can take two cells in some terminals and shift the row.
  // Digits, # and * have the Emoji property too, but always draw one cell.
  const EMOJI_CAPABLE = /(?![0-9#*])\p{Emoji}/u

  const drawnTexts = async (handle: { findAll: (query: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) => [
    ...(await handle.findAll({ type: 'Text' })).map(found => found.text),
    ...(await handle.findAll({ type: 'Button' })).map(found => String(found.props['label'] ?? '')),
  ]

  test('band and pane draw no emoji-capable symbol, in every phase', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, picks({ mode: 'words', words: 10 }))
    await $.session.start(SESSION)
    const { band, pane } = await openFromBand($, clock)
    const seen: string[] = [...(await drawnTexts(band)), ...(await drawnTexts(pane))]

    await typeNextWord(pane)
    seen.push(...(await drawnTexts(pane)))
    for (let index = 1; index < 10; index++) {
      await typeNextWord(pane)
    }
    await pane.press({ key: 'details' })
    seen.push(...(await drawnTexts(pane)), ...(await drawnTexts(band)))

    expect(seen.filter(text => EMOJI_CAPABLE.test(text))).toEqual([])
  })
})

describe('probe: the store, shared by every session', () => {
  test('the record of versions before 0.8 is split into parts and deleted; a newer part is never replaced', async ($, on) => {
    const newerBigrams = { th: { attempts: 3, errors: 0 } }
    const world = stubWorld(on, {
      progress: { version: 1, personalBests: { 'flow:english': { wpm: 50, accuracy: 90, at: 1 } }, history: [], daily: {}, bigrams: { zz: { attempts: 99, errors: 9 } } },
      bigrams: newerBigrams,
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    expect(world.saved.has('progress')).toBe(false)
    expect(world.saved.get('personalBests')).toEqual({ 'flow:english': { wpm: 50, accuracy: 90, at: 1 } })
    expect(world.saved.get('bigrams')).toEqual(newerBigrams)
  })

  test("another session's result saved between this session's read and its save is kept", async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    const otherResult = { key: 'words:10:english', at: 42, wpm: 77, accuracy: 99 }
    let personalBestReads = 0
    world.beforeGet = key => {
      personalBestReads += key === 'personalBests' ? 1 : 0
      // Read 1 is for the summary, read 2 starts the save: the other session's whole save lands in between.
      if (key === 'personalBests' && personalBestReads === 2) {
        world.saved.set('history', [otherResult])
        world.saved.set('personalBests', { 'words:10:english': { wpm: 77, accuracy: 99, at: 42 } })
      }
    }
    const { pane } = await openFromBand($, clock)
    await pane.press({ key: 'pick-words' })
    await pane.press({ key: 'pick-words-25' })
    for (let index = 0; index < 25; index++) {
      await typeNextWord(pane)
    }

    expect(await isFinished(pane)).toBe(true)
    const history = world.saved.get('history') as { key: string }[]
    expect(history.map(entry => entry.key)).toEqual(['words:10:english', 'words:25:english'])
    expect(Object.keys(world.saved.get('personalBests') as object).toSorted()).toEqual(['words:10:english', 'words:25:english'])
  })
})

describe('probe: spaces before a word', () => {
  test('a space in an empty field gives a fresh field, before the test and after a word', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    const { pane } = await openFromBand($, clock)

    // Before the first key: the round stays ready, only the field is new.
    await pane.input({ key: 'r1-f0', text: ' ', kind: 'change' })
    expect(await fieldKey(pane)).toBe('r1-f1')
    expect(await pane.find({ type: 'Input' })).toMatchObject({ props: { placeholder: ' start typing' } })

    // After a word: the extra space is dropped, and the next word is typed as usual.
    await typeNextWord(pane)
    expect(await fieldKey(pane)).toBe('r1-f2')
    await pane.input({ key: 'r1-f2', text: '   ', kind: 'change' })
    expect(await fieldKey(pane)).toBe('r1-f3')
    await typeNextWord(pane)
    expect(await pane.find({ type: 'Text', text: /^2 words$/ })).toBeDefined()
  })
})

describe('probe: paste guard', () => {
  test('text pasted into the field ends in a result that is no personal best try', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, picks({ mode: 'words', words: 10 }))
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)

    // A fixed text, longer than any burst: the guard reads the size of one change, not what it says.
    // (A pasted word of one or two letters is a burst, and stays a fair test.)
    await pane.input({ key: 'r1-f0', text: 'pasted words', kind: 'change' })
    await pressEnter(pane)
    expect(await isFinished(pane)).toBe(true)
    expect(await pane.find({ type: 'Text', text: 'not a personal best try: text was pasted' })).toBeDefined()
  })
})

describe('probe: word lists', () => {
  const listFile = (prefix: string, count = 30) => JSON.stringify({ words: Array.from({ length: count }, (_, index) => `${prefix}${index}`) })

  test('the lists in word-lists/ load, and the chosen one gives the words', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on, picks({ wordList: 'code' }))
    world.wordListFiles = { 'english.json': listFile('eng'), 'code.json': listFile('code') }

    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)
    expect(await currentWord(pane)).toMatch(/^code\d+$/)
  })

  test('a broken file and a list with too few words are left out; an unknown name gets english', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on, picks({ wordList: 'broken' }))
    world.wordListFiles = { 'english.json': listFile('eng'), 'broken.json': '{ "words": [', 'short.json': listFile('short', 5), 'notes.txt': 'not a list' }

    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)
    expect(await currentWord(pane)).toMatch(/^eng\d+$/)
    // Only .json files are read.
    expect(world.fileReads.some(path => path.endsWith('notes.txt'))).toBe(false)
  })

  test('without the folder the built-in list keeps the game working', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)

    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)
    expect(FALLBACK_WORD_LIST.words).toContain(await currentWord(pane))
  })

  test('a flow test adds words from the chosen list, and no key reads a file', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on, picks({ wordList: 'code' }))
    world.wordListFiles = { 'english.json': listFile('eng'), 'code.json': listFile('code') }

    await $.session.start(SESSION)
    const readsAtStart = world.fileReads.length
    const { pane } = await openFromBand($, clock)
    // 45 words: past the first 40, so the words now come from the ones added while typing.
    for (let index = 0; index < 45; index++) {
      await typeNextWord(pane)
    }
    expect(await currentWord(pane)).toMatch(/^code\d+$/)
    expect(world.fileReads.length).toBe(readsAtStart)
  })
})

describe('probe: toolbar and word list', () => {
  const listFile = (prefix: string) => JSON.stringify({ words: Array.from({ length: 30 }, (_, index) => `${prefix}${index}`) })

  const LISTS = () => ({ 'english.json': listFile('eng'), 'english_10k.json': listFile('big'), 'english_1k.json': listFile('mid'), 'code.json': listFile('code') })
  /** The list group's labels in order, as drawn: the toggle, then the lists while open. */
  const listRow = async (pane: PaneHandle): Promise<string[]> => {
    const found = await pane.findAll({})
    const start = found.findIndex(element => element.text === '◍')
    const end = found.findIndex((element, index) => index > start && element.text === '❘')

    return found.slice(start + 1, end).filter(element => element.type === 'Text' || element.type === 'Button').map(element => element.text)
  }

  test('the list opens on a press, showing every other list by its file name; a pick starts a test with it, saves it and closes', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    world.wordListFiles = LISTS()
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)

    expect(await listRow(pane)).toEqual(['english'])
    await pane.press({ key: 'pick-list' })
    // The one in use, then the others in name order, numbers in natural order.
    expect(await listRow(pane)).toEqual(['english', 'code', 'english_1k', 'english_10k'])

    await pane.press({ key: 'pick-list-code' })
    expect(await currentWord(pane)).toMatch(/^code\d+$/)
    expect(await listRow(pane)).toEqual(['code'])
    expect(world.saved.get('settings')).toMatchObject({ wordList: 'code' })
    expect(world.configWrites).toEqual([])

    await pane.press({ key: 'pick-list' })
    expect(await listRow(pane)).toEqual(['code', 'english', 'english_1k', 'english_10k'])
    await pane.press({ key: 'pick-list-english_10k' })
    expect(await currentWord(pane)).toMatch(/^big\d+$/)
    expect(await listRow(pane)).toEqual(['english_10k'])
  })

  test('while a test runs the list cannot switch; on the result card it can', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on, picks({ mode: 'words', words: 10 }))
    world.wordListFiles = LISTS()
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)

    await typeNextWord(pane)
    expect(await pane.find({ key: 'pick-list' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: '◍' })).toBeUndefined()

    for (let index = 1; index < 10; index++) {
      await typeNextWord(pane)
    }
    expect(await isFinished(pane)).toBe(true)
    await pane.press({ key: 'pick-list' })
    await pane.press({ key: 'pick-list-code' })
    expect(await currentWord(pane)).toMatch(/^code\d+$/)
  })

  test('with one list it opens to nothing else', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    const { pane } = await openFromBand($, clock)

    await pane.press({ key: 'pick-list' })
    expect(await listRow(pane)).toEqual(['english'])
  })

  // A pick saves to /config, and each config change reloads the mod: the reload draws the pane
  // before session.start has read the list files again. Once read, the toolbar must draw again.
  test('the lists read at session start reach a pane drawn before them, with no other change', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on)
    world.wordListFiles = LISTS()
    const { pane } = await openFromBand($, clock)
    await pane.press({ key: 'pick-list' })
    expect(await listRow(pane)).toEqual(['english'])

    await $.session.start(SESSION)
    expect(await listRow(pane)).toEqual(['english', 'code', 'english_1k', 'english_10k'])
  })

  test('the toolbar closed: the list, the modes with icons and counts, the mode in use bright, the rest dim', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on, picks({ mode: 'time' }))
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)

    const buttons = (await pane.findAll({ type: 'Button' })).filter(found => found.key?.startsWith('pick-'))
    expect(buttons.map(found => [found.text, found.props['dimColor'] === true])).toEqual([
      ['english', false],
      ['∿ flow', true],
      ['◷ time (30)', false],
      ['☰ words (25)', true],
    ])
  })
})

describe('probe: band text', () => {
  test('the invitation reads "press 1: type while you wait"', async ($, on) => {
    const clock = mock.clock(on)
    stubWorld(on)
    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await clock.advance(3000)
    const band = await $.ui.mount({ plugin: GAME, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

    const drawn = [
      ...(await band.findAll({ type: 'Text' })).map(found => found.text),
      ...(await band.findAll({ type: 'Button' })).map(found => `${String(found.props['hotkey'])}: ${String(found.props['label'])}`),
    ]
    expect(drawn).toEqual(['press', '1: type while you wait'])
    // What to press bright, what it does dim.
    expect((await band.find({ type: 'Text', text: 'press' }))?.props['dimColor']).toBeUndefined()
    expect(await band.find({ type: 'Button', key: 'play' })).toMatchObject({ props: { dimColor: true } })
  })
})

describe('probe: theme colors', () => {
  // The count in use, yellow in the open time group.
  const selectedColor = async (pane: PaneHandle) => {
    if ((await pane.find({ key: 'pick-time-15' })) === undefined) {
      await pane.press({ key: 'pick-time' })
    }

    return (await pane.findAll({ type: 'Text' })).find(found => found.text === '30')?.props['color']
  }

  test('in the dark theme the yellow is #FFCE1B; other themes keep the theme key', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on, picks({ mode: 'time' }))
    world.theme = 'dark'
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)

    expect(await selectedColor(pane)).toBe('#FFCE1B')

    // A theme change in /config shows from the next redraw.
    await $.config.set({ key: 'theme', value: 'light', previous: 'dark', origin: { kind: 'composer' }, provider: { plugin: 'engine', tier: 'core' } })
    await pane.redraw()
    expect(await selectedColor(pane)).toBe('warning')
  })

  test('the colorblind dark theme and a host without /config keep the theme key', async ($, on) => {
    const clock = mock.clock(on)
    const world = stubWorld(on, picks({ mode: 'time' }))
    world.theme = 'dark-daltonized'
    await $.session.start(SESSION)
    const { pane } = await openFromBand($, clock)

    expect(await selectedColor(pane)).toBe('warning')
  })
})
