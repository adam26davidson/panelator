// Watches every tick a scheduler runs and fails a test on an error it did not allow (spec 081).
export interface TickErrorWatcher {
  allow(pattern: RegExp): void;
  unexpected(): string[];
  check(): void;
}

export function watchTickErrors<T extends { tick(): Promise<{ errors: string[] }> }>(target: T): TickErrorWatcher {
  const recorded: string[] = [];
  const allowed: RegExp[] = [];
  const original = target.tick.bind(target);
  target.tick = async () => {
    const result = await original();
    recorded.push(...result.errors);
    return result;
  };
  const unexpected = () => recorded.filter((e) => !allowed.some((p) => p.test(e)));
  return {
    allow: (pattern) => { allowed.push(pattern); },
    unexpected,
    check: () => {
      const bad = unexpected();
      if (bad.length > 0) throw new Error(`unexpected tick errors:\n${bad.join("\n")}`);
    },
  };
}
