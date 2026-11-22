import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type Api, Unauthorized } from "../shared/api/client.ts";
import type { ChangeEntry, ConsoleState, SentChange } from "../shared/api/types.ts";

type Freshness = "fresh" | "stale" | "offline" | "loading";

export type View =
  | { status: "loading"; fresh: Freshness }
  | { status: "signed-out"; fresh: Freshness }
  | { status: "ready"; fresh: Freshness; snapshot: ConsoleState; ageS: number; now: number };

interface Ctx {
  view: View;
  login: string;
  sent: SentChange[];
  send: (kind: string, args: Record<string, unknown>) => Promise<void>;
  /** Forget changes whose outcome has arrived (leaving a screen clears a shown refusal). */
  clearResolved: () => void;
  refetch: () => void;
  /** Ends the session; `afterLogout` runs before the state is read again, so the sign-in card is the one for Home. */
  logout: (afterLogout?: () => void) => Promise<void>;
}

const C = createContext<Ctx | null>(null);

/** Polls `GET /state` every 10 s while visible and at once when the tab regains focus (flow.md, freshness). */
const POLL_MS = 10_000;

export function ConsoleProvider({
  api,
  children,
  nowFn = Date.now,
  pollMs = POLL_MS,
}: {
  api: Api;
  children: ReactNode;
  nowFn?: () => number;
  pollMs?: number;
}) {
  const q = useQuery({
    queryKey: ["state"],
    queryFn: async () => ({ ...(await api.getState()), fetchedAt: nowFn() }),
    refetchInterval: pollMs,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const [now, setNow] = useState(nowFn());
  useEffect(() => {
    const t = setInterval(() => setNow(nowFn()), 1000);
    return () => clearInterval(t);
  }, [nowFn]);
  const [sent, setSent] = useState<SentChange[]>([]);

  const view = useMemo<View>(() => {
    if (q.error instanceof Unauthorized) return { status: "signed-out", fresh: "loading" };
    const snap = q.data?.snapshot;
    if (!q.data || !snap) return { status: "loading", fresh: q.isError ? "offline" : "loading" };
    const ageS = (q.data.age_s ?? 0) + Math.max(0, (now - q.data.fetchedAt) / 1000);
    const fresh: Freshness = q.isError ? "offline" : ageS > 3 * snap.tick_s ? "stale" : "fresh";
    return { status: "ready", fresh, snapshot: snap, ageS, now };
  }, [q.data, q.error, q.isError, now]);

  const refetch = useCallback(() => void q.refetch(), [q]);
  const send = useCallback(
    async (kind: string, args: Record<string, unknown>) => {
      const c = await api.postChange(kind, args);
      setSent((s) => [...s, c]);
    },
    [api],
  );
  const snapChanges = view.status === "ready" ? view.snapshot.changes : null;
  const clearResolved = useCallback(
    () => setSent((s) => s.filter((c) => !snapChanges?.some((x) => x.id === c.id && x.status !== "pending"))),
    [snapChanges],
  );
  const logout = useCallback(
    async (afterLogout?: () => void) => {
      await api.logout();
      afterLogout?.();
      await q.refetch();
    },
    [api, q],
  );

  const login = q.data?.login ?? "";
  const value = useMemo(
    () => ({ view, login, sent, send, clearResolved, refetch, logout }),
    [view, login, sent, send, clearResolved, refetch, logout],
  );
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useConsole(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error("useConsole outside ConsoleProvider");
  return v;
}

/** The newest change this browser sent that `match` accepts, and its outcome once the snapshot reports one. */
export function useChange(match: (c: SentChange) => boolean): { pending?: SentChange; outcome?: ChangeEntry } {
  const { sent, view } = useConsole();
  const mine = [...sent].reverse().find(match);
  if (!mine) return {};
  const known = view.status === "ready" ? view.snapshot.changes.find((c) => c.id === mine.id) : undefined;
  if (!known || known.status === "pending") return { pending: mine };
  return { outcome: known };
}
