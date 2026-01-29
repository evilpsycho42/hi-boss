const ANSI_RESET = "\x1b[0m";
const ANSI_RED = "\x1b[31m";

export function red(text: string): string {
  return `${ANSI_RED}${text}${ANSI_RESET}`;
}
