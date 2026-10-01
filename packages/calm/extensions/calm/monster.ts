import type { Theme } from "@earendil-works/pi-coding-agent";

// Each digit is one square pixel: transparent, body, or eye. Two pixel rows
// share a terminal row, using foreground/background colors for mixed cells.
const SPRITE_WIDTH = 15;
const BODY = [
  "000100000001000",
  "000010000010000",
  "000111111111000",
  "001122111221100",
  "011111111111110",
  "101111111111101",
  "101111111111101",
  "000010000010000",
];
const FEET = [
  ["000010000010000", "000110000011000"],
  ["000010000010000", "000011000110000"],
];
const SMALL_BODY = ["010010", "001100", "011110", "112211", "111111", "101101", "101101", "000000"];
const SMALL_FEET = [["001100", "010010"], ["001100", "001100"]];

export function renderMonster(width: number, tick: number, theme: Theme, fade?: "muted" | "dim"): string[] {
  if (width < 1) return [];
  const step = Math.floor(tick / 2);
  const foot = step % 2;
  const spriteWidth = width >= SPRITE_WIDTH ? SPRITE_WIDTH : width >= 6 ? 6 : 1;
  const pixels = spriteWidth === SPRITE_WIDTH ? [...BODY, ...FEET[foot]!] : spriteWidth === 6
    ? [...SMALL_BODY, ...SMALL_FEET[foot]!] : ["1", "1", foot === 0 ? "1" : "0", foot === 0 ? "0" : "1"];
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
      const topColor = fade ?? (top === "2" ? "text" : "accent");
      const bottomColor = fade ?? (bottom === "2" ? "text" : "accent");
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
