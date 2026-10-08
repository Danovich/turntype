import type { TypingRoundFinished } from '../../types'
import type { Palette } from './palette'
import { modeLabel, progressLabel } from './shared'
import type { ActiveRound, GameElements } from './shared'

type BandElements = Pick<GameElements, 'Box' | 'Button' | 'Text'>

/**
 * `press 1: <label>`: a plain Button always draws as `<hotkey>: <label>`, so the dim "press" goes
 * before it. Its `1` also fires from an empty prompt.
 */
const pressOne = ({ Box, Button, Text }: BandElements, key: string, label: string, onPress: () => void) => (
  <Box flexDirection="row" columnGap={1}>
    <Text dimColor>press</Text>
    <Button key={key} label={label} hotkey="1" plain onPress={onPress} />
  </Box>
)

/** The pane is open but a dialog or a click took the keys: the way back. */
export const backToTypingBand = (elements: BandElements, round: ActiveRound, onOpen: () => void) => {
  const { Box, Text } = elements
  const label = round.phase === 'running' ? `back to typing ⋅ ${progressLabel(round)}` : 'back to typing'

  return (
    <Box flexDirection="row" columnGap={2}>
      {pressOne(elements, 'play', label, onOpen)}
      <Text dimColor>or ctrl+x tab</Text>
    </Box>
  )
}

/** A finished test while the pane is closed: the result in one row, and another test. */
export const resultBand = (elements: BandElements, round: TypingRoundFinished, palette: Palette, onOpen: () => void) => {
  const { Box, Text } = elements

  return (
    <Box flexDirection="row" columnGap={2}>
      <Text color={palette.warning} bold>{`${round.result.wpm} wpm`}</Text>
      <Text dimColor>{`${round.result.accuracy}% accuracy`}</Text>
      {round.progress?.pb.kind === 'new' && <Text color={palette.success} bold>✦ new personal best</Text>}
      {pressOne(elements, 'again', 'again', onOpen)}
    </Box>
  )
}

/** The invitation while Claude works, or a test in progress waiting while the pane is closed. */
export const invitationBand = (elements: BandElements, round: ActiveRound, onOpen: () => void) => {
  const { Box, Text } = elements
  const label = round.phase === 'running' ? `continue ⋅ ${progressLabel(round)}` : 'type while you wait'

  // One space: the mode belongs to the same phrase, `press 1: type while you wait (flow)`.
  return (
    <Box flexDirection="row" columnGap={1}>
      {pressOne(elements, 'play', label, onOpen)}
      <Text dimColor>{`(${modeLabel(round)})`}</Text>
    </Box>
  )
}
