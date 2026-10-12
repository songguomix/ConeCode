/**
 * RSI one-tap start gate — pure so it is unit-tested without React.
 *
 * Screen recording is mandatory, not advisory: the loop verifies itself with
 * its own eyes, so starting half-blind only burns budget. Accessibility rides
 * along because anything beyond read-only moves needs it on macOS.
 */
export function rsiCanStart(args: {
  isMac: boolean;
  screenRecording: boolean;
  accessibility: boolean;
  hasModel: boolean;
}): boolean {
  if (!args.hasModel) return false;
  if (!args.isMac) return true;
  return args.screenRecording && args.accessibility;
}
