/** Each digit three cells wide and three rows tall, in half-block characters. */
const DIGIT_ROWS: Readonly<Record<string, readonly string[]>> = {
  '0': ['█▀█', '█ █', '█▄█'],
  '1': ['▀█ ', ' █ ', '▄█▄'],
  '2': ['▀▀█', '█▀▀', '█▄▄'],
  '3': ['▀▀█', ' ▀█', '▄▄█'],
  '4': ['█ █', '▀▀█', '  █'],
  '5': ['█▀▀', '▀▀█', '▄▄█'],
  '6': ['█▀▀', '█▀█', '█▄█'],
  '7': ['▀▀█', '  █', '  █'],
  '8': ['█▀█', '█▀█', '█▄█'],
  '9': ['█▀█', '▀▀█', '▄▄█'],
}

const BLANK_DIGIT = ['   ', '   ', '   ']

export const BIG_DIGIT_HEIGHT = 3

/** `value` as three rows of block digits, one space between digits: the terminal has one font size. */
export const bigNumberRows = (value: number): readonly string[] => {
  const glyphs = [...String(value)].map(digit => DIGIT_ROWS[digit] ?? BLANK_DIGIT)

  return Array.from({ length: BIG_DIGIT_HEIGHT }, (_, row) => glyphs.map(glyph => glyph[row]).join(' '))
}
