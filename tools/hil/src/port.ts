// Finding the board (spec 106 AC-14). Directory listing and existence checks are injected for tests.
const BY_ID = "/dev/serial/by-id";

export type PortResult = { found: true; path: string } | { found: false; reason: string };

export interface PortDeps {
  env: Record<string, string | undefined>;
  list: () => string[];
  exists: (path: string) => boolean;
  prefixes: string[];
}

export function findPort(deps: PortDeps): PortResult {
  const forced = deps.env.PANELATOR_HIL_PORT;
  if (forced) {
    return deps.exists(forced)
      ? { found: true, path: forced }
      : { found: false, reason: `PANELATOR_HIL_PORT is ${forced}, which does not exist` };
  }
  let names: string[];
  try {
    names = deps.list();
  } catch {
    names = [];
  }
  const matches = names.filter((n) => deps.prefixes.some((p) => n.startsWith(p))).sort();
  if (matches.length === 1) return { found: true, path: `${BY_ID}/${matches[0]}` };
  const looked = `an entry of ${BY_ID} starting with ${deps.prefixes.join(", ")}`;
  if (matches.length === 0) return { found: false, reason: `no board found: looked for ${looked}` };
  return {
    found: false,
    reason: `more than one board candidate (${matches.join(", ")}); set PANELATOR_HIL_PORT to the right one. Looked for ${looked}`,
  };
}
