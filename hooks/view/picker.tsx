import type { TypingRound, TypingSettings } from '../../types'
import { TIME_PRESETS, TYPING_MODE, WORD_PRESETS } from '../engine/settings'
import { totalTargetWords } from '../engine/window'
import { wordListLabel, wordListOrder } from '../engine/word-list'
import type { Palette } from './palette'
import type { GameElements } from './shared'

type PickerElements = Pick<GameElements, 'Box' | 'Button' | 'Text'>

/** One cell each, never emoji: ∿ a flow with no end, ◷ a clock, ☰ lines of words, ◍ a list. */
const MODE_ICON = { flow: '∿', time: '◷', words: '☰' } as const
const LIST_ICON = '◍'

/** The toolbar group showing its options: the word lists, or one mode's counts; none when closed. */
export type OpenOptions = 'list' | 'time' | 'words' | null

export type PickerProps = {
  /** The settings a pick starts from: also each mode's last count, shown beside it. */
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

/** The list's full name for the closed toolbar: a size reads as its family and size (`english 1k`). */
const fullListLabel = (name: string): string => name.replaceAll('_', ' ')

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
      {isInUse ? (
        <Button key={key} label={label} plain onPress={onToggle} />
      ) : (
        <Button key={key} label={label} plain dimColor onPress={onToggle} />
      )}
      {isOpen && options}
    </Box>
  )
}

/**
 * ◍ english 1k ❘ ∿ flow  ◷ time (30)  ☰ words (10) — the word list and the modes with their counts.
 * Each group shows its options on a press and closes on a pick: `◍ english 1k  english  5k  10k
 * code`, `◷ time  15  30  60  120`. Flow has none: a press picks it. No hotkeys: keys type, so Tab
 * reaches the buttons. Every item keeps its width: a word never breaks across rows. Only drawn
 * where a test has not started: before the first key, or on the result card.
 */
export const settingsPicker = (elements: PickerElements, round: TypingRound, props: PickerProps, actions: PickerActions) => {
  const { Box, Button, Text } = elements
  const { settings, palette, openOptions, wordListNames } = props
  const choose = (change: Partial<TypingSettings>) => () => actions.onChoose({ ...settings, ...change })
  const isTimeRound = round.mode === TYPING_MODE.time
  const isWordsRound = round.mode === TYPING_MODE.words

  const listOptions = wordListOrder(wordListNames)
    .filter(name => name !== round.wordList)
    .map(name => pickOption(elements, palette, `pick-list-${name}`, wordListLabel(name, wordListNames), false, choose({ wordList: name })))
  const timeOptions = TIME_PRESETS.map(seconds =>
    pickOption(elements, palette, `pick-time-${seconds}`, String(seconds), isTimeRound && round.timeLimitMs === seconds * 1000, choose({ mode: TYPING_MODE.time, timeSeconds: seconds })),
  )
  const wordsOptions = WORD_PRESETS.map(count =>
    pickOption(elements, palette, `pick-words-${count}`, String(count), isWordsRound && totalTargetWords(round) === count, choose({ mode: TYPING_MODE.words, wordCount: count })),
  )
  const timeCount = isTimeRound ? round.timeLimitMs / 1000 : settings.timeSeconds
  const wordsCount = isWordsRound ? totalTargetWords(round) : settings.wordCount

  return (
    <Box flexDirection="row" columnGap={2}>
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        <Text dimColor>{LIST_ICON}</Text>
        {optionGroup(
          elements,
          'pick-list',
          fullListLabel(round.wordList),
          true,
          openOptions === 'list',
          () => actions.onToggle('list'),
          listOptions,
        )}
      </Box>
      <Text dimColor>❘</Text>
      {round.mode === TYPING_MODE.flow ? (
        <Button key="pick-flow" label={`${MODE_ICON.flow} flow`} plain onPress={() => {}} />
      ) : (
        <Button key="pick-flow" label={`${MODE_ICON.flow} flow`} plain dimColor onPress={choose({ mode: TYPING_MODE.flow })} />
      )}
      {optionGroup(
        elements,
        'pick-time',
        openOptions === 'time' ? `${MODE_ICON.time} time` : `${MODE_ICON.time} time (${timeCount})`,
        isTimeRound,
        openOptions === 'time',
        () => actions.onToggle('time'),
        timeOptions,
      )}
      {optionGroup(
        elements,
        'pick-words',
        openOptions === 'words' ? `${MODE_ICON.words} words` : `${MODE_ICON.words} words (${wordsCount})`,
        isWordsRound,
        openOptions === 'words',
        () => actions.onToggle('words'),
        wordsOptions,
      )}
    </Box>
  )
}
