import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

// Each digit is one square pixel: transparent, body, or eye. Two pixel rows
// share a terminal row, using foreground/background colors for mixed cells.
const SPRITE_WIDTH = 15;

type Sprite = {
  body: string[];
  feet: [string[], string[]];
  smallBody: string[];
  smallFeet: [string[], string[]];
};

const SPRITES: Sprite[] = [
  {
    body: [
      "000100000001000",
      "000010000010000",
      "000111111111000",
      "001122111221100",
      "011111111111110",
      "101111111111101",
      "101111111111101",
      "000010000010000",
    ],
    feet: [
      ["000010000010000", "000110000011000"],
      ["000010000010000", "000011000110000"],
    ],
    smallBody: ["010010", "001100", "011110", "112211", "111111", "101101", "101101", "000000"],
    smallFeet: [["001100", "010010"], ["001100", "001100"]],
  },
  {
    body: [
      "010000000000010",
      "001000000000100",
      "001011111110100",
      "011112121211110",
      "111111111111111",
      "101110111011101",
      "001111111111100",
      "000100000001000",
    ],
    feet: [
      ["001100000001100", "010000000000010"],
      ["000110000011000", "001000000000100"],
    ],
    smallBody: ["100001", "010010", "011110", "121121", "111111", "011110", "010010", "000000"],
    smallFeet: [["010010", "100001"], ["001100", "010010"]],
  },
  {
    body: [
      "000010000010000",
      "000100000001000",
      "001111111111100",
      "011211111112110",
      "111112222111111",
      "101111111111101",
      "001011111110100",
      "000001000100000",
    ],
    feet: [
      ["000011000110000", "000100000001000"],
      ["000001111100000", "000010000010000"],
    ],
    smallBody: ["001100", "010010", "111111", "211112", "112211", "111111", "010010", "000000"],
    smallFeet: [["011110", "100001"], ["001100", "010010"]],
  },
  {
    body: [
      "000000101000000",
      "000001111100000",
      "000111111111000",
      "001122121221100",
      "011111111111110",
      "111011111110111",
      "001111111111100",
      "000010010010000",
    ],
    feet: [
      ["000110000011000", "001000000000100"],
      ["000011000110000", "000100000001000"],
    ],
    smallBody: ["001100", "011110", "111111", "122121", "111111", "101101", "011110", "000000"],
    smallFeet: [["010010", "100001"], ["001100", "010010"]],
  },
  {
    body: [
      "000100000001000",
      "001110000011100",
      "011111111111110",
      "111121111121111",
      "101111222111101",
      "001111111111100",
      "000111111111000",
      "000010000010000",
    ],
    feet: [
      ["000110000011000", "001000000000100"],
      ["000011000110000", "000100000001000"],
    ],
    smallBody: ["010010", "111111", "121121", "111111", "112211", "011110", "001100", "000000"],
    smallFeet: [["010010", "100001"], ["001100", "010010"]],
  },
];

export const MONSTER_COUNT = SPRITES.length;

export function renderMonster(
  width: number,
  tick: number,
  theme: Theme,
  fade?: "muted" | "dim",
  monsterIndex = 0,
  bodyColor: ThemeColor = "accent",
): string[] {
  if (width < 1) return [];
  const step = Math.floor(tick / 2);
  const foot = step % 2;
  const spriteWidth = width >= SPRITE_WIDTH ? SPRITE_WIDTH : width >= 6 ? 6 : 1;
  const sprite = SPRITES[((monsterIndex % MONSTER_COUNT) + MONSTER_COUNT) % MONSTER_COUNT]!;
  const pixels = spriteWidth === SPRITE_WIDTH ? [...sprite.body, ...sprite.feet[foot]!] : spriteWidth === 6
    ? [...sprite.smallBody, ...sprite.smallFeet[foot]!] : ["1", "1", foot === 0 ? "1" : "0", foot === 0 ? "0" : "1"];
  const span = width - spriteWidth;
  const phase = span > 0 ? step % (span * 2) : 0;
  const column = phase <= span ? phase : span * 2 - phase;
  const padding = " ".repeat(column);
  const blinking = tick % 40 >= 38;
  const lines: string[] = [];
  for (let row = 0; row < pixels.length; row += 2) {
    let line = padding;
    for (let x = 0; x < spriteWidth; x++) {
      let top = pixels[row]![x]!;
      let bottom = pixels[row + 1]![x]!;
      if (blinking) {
        if (top === "2") top = "1";
        if (bottom === "2") bottom = "1";
      }
      const topColor = fade ?? (top === "2" ? "text" : bodyColor);
      const bottomColor = fade ?? (bottom === "2" ? "text" : bodyColor);
      if (top === "0" && bottom === "0") line += " ";
      else if (top === "0") line += theme.fg(bottomColor, "▄");
      else if (bottom === "0") line += theme.fg(topColor, "▀");
      else if (top === bottom) line += theme.fg(topColor, "█");
      else line += theme.style("▀", { fg: topColor, bg: theme.colors[bottomColor] });
    }
    lines.push(line);
  }
  return lines;
}
