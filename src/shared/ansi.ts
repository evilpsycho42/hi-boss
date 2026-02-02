const ANSI_RESET = "\x1b[0m";
const ANSI_RED = "\x1b[31m";
// 256-color palette orange (approx). Falls back gracefully in terminals without 256-color support.
const ANSI_ORANGE = "\x1b[38;5;208m";

export function red(text: string): string {
  return `${ANSI_RED}${text}${ANSI_RESET}`;
}

export function orange(text: string): string {
  return `${ANSI_ORANGE}${text}${ANSI_RESET}`;
}
