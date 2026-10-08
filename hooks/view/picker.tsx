import type { TypingCountedMode, TypingMode, TypingSettings } from '../../types'
import { isCountedMode, MODES, TYPING_MODES } from '../engine/modes'
import { wordListOrder } from '../engine/word-list'
import type { Palette } from './palette'
import type { GameElements } from './shared'

type PickerElements = Pick<GameElements, 'Box' | 'Button' | 'Text'>

/** One cell each, never emoji: ∿ a flow with no end, ◷ a clock, ☰ lines of words, ◍ a list. */
const MODE_ICON: Readonly<Record<TypingMode, string>> = { flow: '∿', time: '◷', words: '☰' }
const LIST_ICON = '◍'

/** The toolbar group showing its options: the word lists, or one mode's counts; none when closed. */
export type OpenOptions = 'list' | TypingCountedMode | null

export type PickerProps = {
  /** The settings in use: what the toolbar marks, what a pick starts from, each mode's last count. */
  readonly settings: TypingSettings
  /** Every word list read from `word-lists/`. */
  readonly wordListNames: readonly string[]
  readonly palette: Palette
  readonly openOptions: OpenOptions
}

export type PickerActions = {
  /** A pick: the settings change, and the open group closes. */
  readonly onChoose: (chosen: TypingSettings) => void
  /** Opens a group's options, or closes them when they are open; chooses nothing. */
  readonly onToggle: (group: Exclude<OpenOptions, null>) => void
}

/** One option to pick: the one in use yellow text (pressing it would change nothing), any other a dim button. */
const pickOption = ({ Box, Button, Text }: PickerElements, palette: Palette, key: string, label: string, isSelected: boolean, onPick: () => void) =>
  isSelected ? (
    <Box key={key} flexShrink={0}>
      <Text color={palette.warning} bold>{label}</Text>
    </Box>
  ) : (
    <Button key={key} label={label} plain dimColor onPress={onPick} />
  )

/**
 * One toolbar group: a button that shows or hides its options, then the options while open. The
 * button keeps its key open or closed, so the focus ring stays on it. Bright when it is the setting
 * in use, dim otherwise: a Button has no color.
 */
const optionGroup = (
  elements: PickerElements,
  key: string,
  label: string,
  isInUse: boolean,
  isOpen: boolean,
  onToggle: () => void,
  options: readonly ReturnType<typeof pickOption>[],
) => {
  const { Box, Button } = elements

  return (
    <Box flexDirection="row" columnGap={2} flexShrink={0}>
      <Button key={key} label={label} plain dimColor={!isInUse} onPress={onToggle} />
      {isOpen && options}
    </Box>
  )
}

/**
 * ◍ english 1k ❘ ∿ flow  ◷ time (30)  ☰ words (10) — the word list, then each mode of `modes.ts` in
 * order, all read from the settings in use: the next test is made from them. A group shows its
 * options on a press and closes on a pick: `◍ english 1k  english  5k  10k  code`, `◷ time  15  30
 * 60  120`. A mode without a count (flow) is one button: a press picks it. No hotkeys: keys type, so
 * Tab reaches the buttons. Every item keeps its width: a word never breaks across rows. Only drawn
 * where a test has not started: before the first key, or on the result card.
 */
export const settingsPicker = (elements: PickerElements, props: PickerProps, actions: PickerActions) => {
  const { Box, Button, Text } = elements
  const { settings, palette, openOptions, wordListNames } = props
  const choose = (change: Partial<TypingSettings>) => () => actions.onChoose({ ...settings, ...change })
  // A mode in use with nothing to pick: its press closes an open group instead.
  const closeOpen = () => {
    if (openOptions !== null) {
      actions.onToggle(openOptions)
    }
  }

  const listOptions = wordListOrder(wordListNames)
    .filter(name => name !== settings.wordList)
    .map(name => pickOption(elements, palette, `pick-list-${name}`, name, false, choose({ wordList: name })))

  const modeItem = (mode: TypingMode) => {
    const label = `${MODE_ICON[mode]} ${mode}`
    const isInUse = settings.mode === mode

    if (!isCountedMode(mode)) {
      return <Button key={`pick-${mode}`} label={label} plain dimColor={!isInUse} onPress={isInUse ? closeOpen : choose({ mode })} />
    }
    const isOpen = openOptions === mode
    const options = MODES[mode].count.presets.map(count =>
      pickOption(
        elements,
        palette,
        `pick-${mode}-${count}`,
        String(count),
        isInUse && settings.counts[mode] === count,
        choose({ mode, counts: { ...settings.counts, [mode]: count } }),
      ),
    )

    return optionGroup(elements, `pick-${mode}`, isOpen ? label : `${label} (${settings.counts[mode]})`, isInUse, isOpen, () => actions.onToggle(mode), options)
  }

  return (
    <Box flexDirection="row" columnGap={2}>
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        <Text dimColor>{LIST_ICON}</Text>
        {optionGroup(elements, 'pick-list', settings.wordList, true, openOptions === 'list', () => actions.onToggle('list'), listOptions)}
      </Box>
      <Text dimColor>❘</Text>
      {TYPING_MODES.map(modeItem)}
    </Box>
  )
}
