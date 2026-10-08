import type { TypingRound, TypingSettings } from '../../types'
import { TIME_PRESETS, TYPING_MODE, WORD_PRESETS } from '../engine/settings'
import { totalTargetWords } from '../engine/window'
import type { Palette } from './palette'
import type { GameElements } from './shared'

type PickerElements = Pick<GameElements, 'Box' | 'Button' | 'Text'>

/** One cell each, never emoji: ∿ a flow with no end, ◷ a clock, ☰ lines of words, ◍ a list. */
const MODE_ICON = { flow: '∿', time: '◷', words: '☰' } as const
const LIST_ICON = '◍'

/**
 * `◍ english` in the toolbar: a press moves to the next list. With one list only it is a plain label.
 * Only drawn where a test has not started: before the first key, or on the result card.
 */
const wordListOption = ({ Button, Text }: PickerElements, round: TypingRound, wordListNames: readonly string[], onNext: (name: string) => void) => {
  const label = `${LIST_ICON} ${round.wordList}`
  const nextName = wordListNames[(wordListNames.indexOf(round.wordList) + 1) % wordListNames.length]

  return nextName !== undefined && nextName !== round.wordList ? (
    <Button key="pick-list" label={label} plain dimColor onPress={() => onNext(nextName)} />
  ) : (
    <Text dimColor>{label}</Text>
  )
}

/**
 * ◍ english ❘ ∿ flow  ◷ time  ☰ words ❘ 15 30 60 120: the word list, the modes, the selected mode's
 * counts. What is on show is yellow text (a Button has no color, and pressing the test on show would
 * only restart it); the rest dim buttons. A mode alone keeps its last count. No hotkeys: keys type.
 */
export const settingsPicker = (
  elements: PickerElements,
  round: TypingRound,
  settings: TypingSettings,
  wordListNames: readonly string[],
  palette: Palette,
  onChoose: (chosen: TypingSettings) => void,
) => {
  const { Box, Button, Text } = elements
  const option = (key: string, label: string, change: Partial<TypingSettings>, isSelected: boolean) =>
    isSelected ? (
      <Text key={key} color={palette.warning} bold>{label}</Text>
    ) : (
      <Button key={key} label={label} plain dimColor onPress={() => onChoose({ ...settings, ...change })} />
    )
  const counts =
    round.mode === TYPING_MODE.time
      ? TIME_PRESETS.map(seconds =>
          option(`pick-time-${seconds}`, String(seconds), { mode: TYPING_MODE.time, timeSeconds: seconds }, round.timeLimitMs === seconds * 1000),
        )
      : round.mode === TYPING_MODE.words
        ? WORD_PRESETS.map(count =>
            option(`pick-words-${count}`, String(count), { mode: TYPING_MODE.words, wordCount: count }, totalTargetWords(round) === count),
          )
        : []

  return (
    <Box flexDirection="row" columnGap={2}>
      {wordListOption(elements, round, wordListNames, wordList => onChoose({ ...settings, wordList }))}
      <Text dimColor>❘</Text>
      {option('pick-flow', `${MODE_ICON.flow} flow`, { mode: TYPING_MODE.flow }, round.mode === TYPING_MODE.flow)}
      {option('pick-time', `${MODE_ICON.time} time`, { mode: TYPING_MODE.time }, round.mode === TYPING_MODE.time)}
      {option('pick-words', `${MODE_ICON.words} words`, { mode: TYPING_MODE.words }, round.mode === TYPING_MODE.words)}
      {counts.length > 0 && <Text dimColor>❘</Text>}
      {counts}
    </Box>
  )
}
