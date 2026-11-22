import { useSearch } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useChange, useConsole } from "../../app/ConsoleProvider.tsx";
import { Screen } from "../../app/layout/Shell.tsx";
import { Pending, Refused } from "../../features/changes/ChangeOutcome.tsx";
import type { Parameter } from "../../shared/api/types.ts";
import { dayMonth } from "../../shared/lib/format.ts";
import { Icon } from "../../shared/ui/Icon.tsx";
import { Empty, Skel } from "../../shared/ui/parts.tsx";

const COLS = ["Parameter", "Value", "Mode", "Last set"];
const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function limits(p: Parameter): string {
  if (p.min === undefined && p.max === undefined) return p.type === "boolean" ? "on or off" : p.type;
  return [p.min !== undefined ? `min ${p.min}` : null, p.max !== undefined ? `max ${p.max}` : null]
    .filter(Boolean)
    .join(" · ");
}

/** Text to the typed value the definition expects; null when a number does not parse. */
function parse(p: Parameter, text: string): unknown {
  if (p.type === "number") return text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : null;
  return text;
}

function Row({ p, focus }: { p: Parameter; focus: boolean }) {
  const { send, view } = useConsole();
  const offline = view.fresh === "offline";
  const [edit, setEdit] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLLIElement>(null);
  const value = useChange((c) => c.kind === "set_parameter" && c.args.name === p.name);
  const mode = useChange((c) => c.kind === "set_parameter_mode" && c.args.name === p.name);
  const refused = value.outcome?.status === "refused" ? (value.outcome.reason ?? "refused") : null;
  const modeRefused = mode.outcome?.status === "refused" ? (mode.outcome.reason ?? "refused") : null;
  const pendingValue = value.pending ? value.pending.args.value : undefined;
  const pendingMode = mode.pending ? (mode.pending.args.mode as "auto" | "locked") : undefined;
  const failedValue = refused ? shown(value.outcome?.args.value) : undefined;

  useEffect(() => {
    if (!focus) return;
    row.current?.scrollIntoView?.({ block: "center" });
    input.current?.focus();
  }, [focus]);

  const post = (text: string) => {
    const v = parse(p, text);
    if (v === null) return;
    void send("set_parameter", { name: p.name, value: v }).catch(() => undefined);
    setEdit(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && edit !== null) post(edit);
    if (e.key === "Escape") setEdit(null);
  };
  const current = shown(p.value);
  const text = pendingValue !== undefined ? shown(pendingValue) : (edit ?? failedValue ?? current);
  const cls = refused && edit === null ? " bad" : edit !== null ? " edited" : "";
  const m = pendingMode ?? p.mode;
  const lockedNote = m === "locked" && !pendingMode;
  return (
    <li ref={row} className={`c-trow c-params-grid${focus ? " c-focus" : ""}`} id={`parameters-${p.name}`}>
      <div className="c-section" style={{ gap: 4 }}>
        <span className="c-strong c-mono" style={{ fontSize: "var(--text-base)", wordBreak: "break-word" }}>
          {p.name}
        </span>
        <span className="c-sm c-muted">{p.description}</span>
        <span className="c-sm c-only-wide">{limits(p)}</span>
      </div>
      <div className="c-section" style={{ gap: 8 }}>
        <div className="c-wrap c-only-narrow c-sm c-muted" style={{ justifyContent: "space-between" }}>
          <span>Value · {limits(p)}</span>
        </div>
        {p.type === "boolean" ? (
          <div className="c-seg-ctl" role="group" aria-label={`${p.name} value`}>
            <button
              type="button"
              aria-pressed={(pendingValue ?? p.value) === true}
              disabled={offline || !!value.pending}
              onClick={() => void send("set_parameter", { name: p.name, value: true }).catch(() => undefined)}
            >
              On
            </button>
            <button
              type="button"
              aria-pressed={(pendingValue ?? p.value) !== true}
              disabled={offline || !!value.pending}
              onClick={() => void send("set_parameter", { name: p.name, value: false }).catch(() => undefined)}
            >
              Off
            </button>
          </div>
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: blur handling for the Save button inside the field
          <div
            className="c-field"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEdit(null);
            }}
          >
            <input
              ref={input}
              className={`c-input${p.type === "string" ? " wide" : ""}${cls}`}
              value={text}
              readOnly={offline || pendingValue !== undefined}
              aria-label={`${p.name} value`}
              onChange={(e) => setEdit(e.target.value)}
              onKeyDown={onKey}
            />
            {edit !== null && edit !== current ? (
              <button type="button" className="c-btn primary" disabled={offline} onClick={() => post(edit)}>
                Save
              </button>
            ) : null}
          </div>
        )}
        {value.pending ? (
          <Pending>
            Set to {shown(pendingValue)}, sent as change {value.pending.id}. Waiting for the scheduler.
          </Pending>
        ) : null}
        {refused ? (
          <Refused>
            Refused: {refused}. The value stays {current}.
          </Refused>
        ) : null}
      </div>
      <div className="c-section" style={{ gap: 8 }}>
        <span className="c-sm c-muted c-only-narrow">Mode</span>
        <div className="c-seg-ctl" role="group" aria-label={`${p.name} mode`}>
          <button
            type="button"
            className="auto"
            aria-pressed={m === "auto"}
            disabled={offline || !!mode.pending}
            onClick={() => void send("set_parameter_mode", { name: p.name, mode: "auto" }).catch(() => undefined)}
          >
            Auto
          </button>
          <button
            type="button"
            className="locked"
            aria-pressed={m === "locked"}
            disabled={offline || !!mode.pending}
            onClick={() => void send("set_parameter_mode", { name: p.name, mode: "locked" }).catch(() => undefined)}
          >
            {Icon.lock(14)} Locked
          </button>
        </div>
        {mode.pending ? (
          <Pending>
            Mode set to {pendingMode}, sent as change {mode.pending.id}. Waiting for the scheduler.
          </Pending>
        ) : modeRefused ? (
          <Refused>Refused: {modeRefused}</Refused>
        ) : lockedNote ? (
          <div className="c-note locked" style={{ padding: "6px 10px" }}>
            {Icon.lock(16)}
            <span>Locked: the system cannot change this. You can.</span>
          </div>
        ) : null}
      </div>
      <div className="c-section" style={{ gap: 2 }}>
        <span className="c-sm c-muted c-only-narrow">Last set</span>
        <span className="c-sm c-muted">
          {p.set_by === "maintainer" ? "you" : (p.set_by ?? "default")}
          {p.at ? `, ${dayMonth(p.at)}` : ""}
        </span>
      </div>
    </li>
  );
}

export function Parameters() {
  const { focus } = useSearch({ strict: false }) as { focus?: string };
  return (
    <Screen
      screen="parameters"
      skeleton={
        <div className="c-card c-section" aria-busy="true">
          {[0, 1, 2, 3, 4].map((k) => (
            <Skel key={k} h={72} />
          ))}
        </div>
      }
    >
      {(s) =>
        s.parameters.length === 0 ? (
          <Empty icon={Icon.sliders(24)} title="No parameters">
            The snapshot carries no parameter definitions. Parameters added in agents/parameters.yaml appear here with
            an Auto / Locked switch.
          </Empty>
        ) : (
          <>
            <p className="c-muted c-sm">
              <b>Auto</b>: agents may change the value within its limits. <b>Locked</b>: only you can change it. Every
              change is applied by the scheduler as you, the maintainer.
            </p>
            <div className="c-card c-tbody">
              <div className="c-thead c-params-grid" aria-hidden="true">
                {COLS.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <ul>
                {s.parameters.map((p) => (
                  <Row key={p.name} p={p} focus={focus === p.name} />
                ))}
              </ul>
            </div>
          </>
        )
      }
    </Screen>
  );
}
