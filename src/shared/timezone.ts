export function getDaemonIanaTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  const tz = timeZone.trim();
  if (!tz) return false;
  try {
    // Throws RangeError for invalid timeZone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

