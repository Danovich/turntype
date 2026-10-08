import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const PANE_PROPS = {
  title: 'turntype',
  isFocused: true,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

// What the engine draws in a site no plugin fills.
const EMPTY_SITE = { type: 'Box', props: {} } as const

/** Answers what Claude Code itself would, beneath the mod, and tracks which panes are open. */
/** Types `text` into the field `key`, one key per change, as a player does: a whole word at once is a paste. */
const typeKeys = async (pane: { input: (target: { key: string; text: string; kind: 'change' }) => Promise<unknown> }, key: string, text: string, base = ''): Promise<void> => {
  for (let length = 1; length <= text.length; length++) {
    await pane.input({ key, text: base + text.slice(0, length), kind: 'change' })
  }
}

const stubEngine = (on: On): void => {
  const openPaneIds = new Set<string>()

  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => EMPTY_SITE)
  on('ui.toast', () => ({ value: undefined }))
  on('config.set', (_, e) => ({ value: e.value }))
  on('ui.open', (_, e) => {
    openPaneIds.add(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    openPaneIds.delete(e.id)

    return { value: undefined }
  })
  on('ui.focus', () => ({}))
  on('ui.panes', () => ({
    value: [...openPaneIds].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })),
  }))
}

/** The plugin's store in memory; the map it returns shows what the mod saved. */
const stubStore = (on: On): Map<string, unknown> => {
  const savedValues = new Map<string, unknown>()

  on('store.get', (_, e) => ({ value: savedValues.get(e.key) }))
  on('store.set', (_, e) => (savedValues.set(e.key, e.value), { value: undefined }))

  return savedValues
}

/** The picker's selected options: bold yellow text, no longer buttons (`flow`, `time`, `30`, ...). */
const selectedOptions = async (pane: { findAll: (query: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) =>
  (await pane.findAll({ type: 'Text' }))
    .filter(found => found.props['bold'] === true && /^(?:\S )?(?:flow|time|words)$|^\d+$/.test(found.text))
    // Without the mode icon: "◷ time" is "time".
    .map(found => found.text.replace(/^\S /, ''))

describe('turntype', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: band invitation, "1" opens the pane, typing, claude done, result, again`, async ($, on) => {
      const clock = mock.clock(on)
      const savedValues = stubStore(on)
      stubEngine(on)

      await $.turn.start({ text: 'go', turnId: 'turn-1' })
      const band = await $.ui.mount({ plugin: 'turntype', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(await band.find({ type: 'Button', key: 'play' })).toBeUndefined()

      await clock.advance(1500)
      expect(await band.find({ type: 'Button', key: 'play' })).toMatchObject({ props: { hotkey: '1', plain: true } })

      await band.press({ key: 'play' })
      expect(await band.find({ type: 'Button', key: 'play' })).toBeUndefined()

      const pane = await $.ui.mount({ plugin: 'turntype', surface, component: 'Pane', requestId: 'turntype', props: PANE_PROPS })
      expect(await pane.find({ type: 'Input', key: 'r1-f0' })).toBeDefined()

      // The words rows hold only target text; the toolbar (`◍ english`) comes after them.
      const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
      const wordsText = texts.slice(0, texts.findIndex(text => text.startsWith('◍'))).join('')
      const [firstWord = '', secondWord = '', thirdWord = ''] = wordsText.split(' ').filter(Boolean)

      await typeKeys(pane, 'r1-f0', `${firstWord} `)
      await typeKeys(pane, 'r1-f1', `${secondWord} `)
      expect(await pane.find({ type: 'Text', text: /^2 words$/ })).toBeDefined()

      // A typo shows the target letter in red, never the typed one.
      await typeKeys(pane, 'r1-f2', `#${thirdWord.slice(1)}`)
      // A string `text` query matches by substring, so compare the red runs exactly.
      const drawnTexts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
      const redTexts = (await pane.findAll({ type: 'Text' }))
        .filter(found => found.props['color'] === 'error')
        .map(found => found.text)
      expect(drawnTexts.some(text => text.includes('#'))).toBe(false)
      expect(redTexts[0]?.startsWith(thirdWord.slice(0, 1))).toBe(true)

      await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 'turn-1' })
      expect(await pane.find({ type: 'Text', text: /Claude is done/ })).toBeDefined()

      await pane.input({ key: 'r1-f2', text: `#${thirdWord.slice(1)}`, kind: 'submit' })
      expect(await pane.find({ type: 'Text', text: /^wpm$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /% accuracy$/ })).toBeDefined()

      // The character counts wait behind "details".
      expect(await pane.find({ type: 'Text', text: /wrong 1/ })).toBeUndefined()
      await pane.press({ key: 'details' })
      expect(await pane.find({ type: 'Text', text: /wrong 1 ⋅ extra 0 ⋅ missed 0/ })).toBeDefined()

      // A flow test of a few seconds is saved for today, but can never be a personal best.
      expect(await pane.find({ type: 'Text', text: 'not a personal best try: under 15 s' })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^today 1 test$/ })).toBeDefined()
      // One key per part: no fair result yet, but today's total holds the test.
      expect(savedValues.get('history')).toEqual([])
      expect(Object.values(savedValues.get('daily') as Record<string, unknown>)).toMatchObject([{ tests: 1 }])

      await pane.press({ key: 'again' })
      expect(await pane.find({ type: 'Input', key: 'r2-f0' })).toBeDefined()
      await pane.unmount()
      await band.unmount()
    })
  }

  test('after "x: close" on the result, the next turn shows the invitation again', async ($, on) => {
    const clock = mock.clock(on)
    stubEngine(on)

    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await clock.advance(1500)
    const band = await $.ui.mount({ plugin: 'turntype', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await band.press({ key: 'play' })
    const pane = await $.ui.mount({ plugin: 'turntype', surface: 'terminal', component: 'Pane', requestId: 'turntype', props: PANE_PROPS })
    await pane.input({ key: 'r1-f0', text: 'x', kind: 'change' })
    await pane.input({ key: 'r1-f0', text: 'x', kind: 'submit' })
    await pane.press({ key: 'close' })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 'turn-1' })

    await $.turn.start({ text: 'again', turnId: 'turn-2' })
    await clock.advance(1500)
    expect(await band.find({ type: 'Button', key: 'play' })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })

  test('a permission dialog takes the keys: the mod asks for them back, the band shows the way back meanwhile', async ($, on) => {
    const clock = mock.clock(on)
    // The engine beneath, with the pane's keyboard under the test's control.
    const focus = { isPaneFocused: true, isDialogOpen: false, focusRequests: 0 }
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    on('ui.render', () => EMPTY_SITE)
    on('tool.check', () => ({ decision: 'ask' as const }))
    on('ui.open', (_, e) => {
      if (e.focus && !focus.isDialogOpen) {
        focus.focusRequests++
        focus.isPaneFocused = true
      }

      return { value: { isPlaced: true } }
    })
    on('ui.panes', () => ({
      value: [{ id: 'turntype', title: 'turntype', isShown: true, isFocused: focus.isPaneFocused, isPlaced: true }],
    }))

    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await clock.advance(1500)
    const band = await $.ui.mount({ plugin: 'turntype', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await band.press({ key: 'play' })
    focus.focusRequests = 0

    // The dialog opens and holds the keys: a focus request now is refused.
    await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
    expect(focus.focusRequests).toBe(0)
    focus.isDialogOpen = true
    focus.isPaneFocused = false
    await clock.advance(400)
    expect(await band.find({ type: 'Button', key: 'play' })).toMatchObject({ props: { label: 'back to typing', hotkey: '1' } })

    // The dialog closes: the next look hands the keys back to the game.
    focus.isDialogOpen = false
    await clock.advance(400)
    expect(focus.focusRequests).toBe(1)
    await clock.advance(400)
    expect(await band.find({ type: 'Button', key: 'play' })).toBeUndefined()
    await band.unmount()
  })

  test('a turn shorter than the delay never shows the band', async ($, on) => {
    const clock = mock.clock(on)
    stubEngine(on)

    await $.turn.start({ text: 'hi', turnId: 'turn-1' })
    await clock.advance(500)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 500, isAborted: false, turnId: 'turn-1' })
    await clock.advance(2000)
    const band = await $.ui.mount({ plugin: 'turntype', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ type: 'Button' })).toBeUndefined()
    await band.unmount()
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: the picker: "time" shows its counts, "15" makes a time 15 test at once and closes them`, async ($, on) => {
      const clock = mock.clock(on)
      stubEngine(on)

      await $.turn.start({ text: 'go', turnId: 'turn-1' })
      await clock.advance(1500)
      const band = await $.ui.mount({ plugin: 'turntype', surface, component: 'AbovePrompt', props: BAND_PROPS })
      await band.press({ key: 'play' })
      const pane = await $.ui.mount({ plugin: 'turntype', surface, component: 'Pane', requestId: 'turntype', props: PANE_PROPS })

      // Closed: flow in use (bright), time and words dim with their counts, no counts on show.
      expect((await pane.find({ type: 'Button', key: 'pick-flow' }))?.props['dimColor']).toBeUndefined()
      expect(await pane.find({ type: 'Button', key: 'pick-time' })).toMatchObject({ props: { label: '◷ time (30)', dimColor: true } })
      expect(await pane.find({ type: 'Button', key: 'pick-time-15' })).toBeUndefined()

      // "time" shows its counts and changes nothing yet.
      await pane.press({ key: 'pick-time' })
      expect(await pane.find({ type: 'Input', key: 'r1-f0' })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'pick-time-15' })).toMatchObject({ props: { dimColor: true } })

      // A count picks time with it at once, and the counts close.
      await pane.press({ key: 'pick-time-15' })
      expect(await pane.find({ type: 'Input', key: 'r2-f0' })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'pick-time' })).toMatchObject({ props: { label: '◷ time (15)' } })
      expect(await pane.find({ type: 'Button', key: 'pick-time-15' })).toBeUndefined()

      // Once the first key is in, the picker gives its row to the key hints.
      await pane.input({ key: 'r2-f0', text: 'x', kind: 'change' })
      expect(await pane.find({ key: 'pick-flow' })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: 'esc: hide' })).toBeDefined()
      await pane.unmount()
      await band.unmount()
    })
  }
})
