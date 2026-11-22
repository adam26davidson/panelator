/** Spec 051 AC-3: state changes the console shows (question, claim, action, parameter) tell the pusher, which debounces to one push per `push_min_s`. */
let hook: (() => void) | null = null;
export function setConsoleNotifier(fn: (() => void) | null): void { hook = fn; }
export function consoleNotify(): void { try { hook?.(); } catch { /* the console never blocks the change */ } }
