import { Screen } from "../../app/layout/Shell.tsx";
import type { Question } from "../../shared/api/types.ts";
import { ago } from "../../shared/lib/format.ts";
import { Icon } from "../../shared/ui/Icon.tsx";
import { Empty, Skel } from "../../shared/ui/parts.tsx";

const KIND_TONE: Record<string, string> = { product: "violet", technical: "accent", capability: "warn" };

function OpenQuestion({ q, now, repo }: { q: Question; now: number; repo: string }) {
  return (
    <li className="c-card c-section" style={{ gap: 12 }}>
      <div className="c-wrap">
        <a
          className="c-link"
          style={{ minWidth: 44, fontSize: "var(--text-base)" }}
          href={`https://github.com/${repo}/issues/${q.issue}`}
          target="_blank"
          rel="noreferrer"
        >
          #{q.issue}
        </a>
        <span className={`c-badge ${KIND_TONE[q.kind] ?? ""}`}>{q.kind}</span>
        {q.status === "reminded" ? (
          <span className="c-badge warn">Reminded</span>
        ) : (
          <span className="c-badge accent">Open</span>
        )}
        <span className="c-sm c-muted">
          asked {ago(q.asked_at, now)}
          {q.reminded_at ? ` · reminded ${ago(q.reminded_at, now)}` : ""}
        </span>
      </div>
      <p style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>{q.text}</p>
      {q.options.length ? (
        <ol className="c-list" style={{ gap: 8 }}>
          {q.options.map((o, i) => (
            <li key={o.label} className="c-row" style={{ alignItems: "flex-start", gap: 10 }}>
              <span className="c-badge" style={{ minWidth: 30, justifyContent: "center" }}>
                {i + 1}
              </span>
              <span className="c-strong">
                {o.label}
                {o.cost ? <span className="c-sm c-muted"> · {o.cost}</span> : null}
                {o.recommended ? (
                  <span className="c-sm" style={{ color: "var(--color-ok)", fontWeight: 600 }}>
                    {" "}
                    · recommended
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="c-wrap" style={{ gap: 12 }}>
        <a className="c-btn primary" href={q.question_url} target="_blank" rel="noreferrer">
          Answer on GitHub {Icon.external(16)}
        </a>
        {q.telegram_url ? (
          <a className="c-btn" href={q.telegram_url} target="_blank" rel="noreferrer">
            Open Telegram chat {Icon.external(16)}
          </a>
        ) : null}
      </div>
    </li>
  );
}

function AnsweredQuestion({ q, now, repo }: { q: Question; now: number; repo: string }) {
  return (
    <li className="c-card c-section" style={{ gap: 8 }}>
      <div className="c-wrap">
        <a
          className="c-link"
          style={{ minWidth: 44, fontSize: "var(--text-base)" }}
          href={`https://github.com/${repo}/issues/${q.issue}`}
          target="_blank"
          rel="noreferrer"
        >
          #{q.issue}
        </a>
        <span className={`c-badge ${KIND_TONE[q.kind] ?? ""}`}>{q.kind}</span>
        <span className="c-badge ok">{Icon.check(14)} Answered</span>
        {q.answered_at ? <span className="c-sm c-muted">answered {ago(q.answered_at, now)}</span> : null}
      </div>
      <p>{q.text}</p>
      <div className="c-wrap" style={{ gap: 16 }}>
        {q.decision_url ? (
          <a className="c-link" href={q.decision_url} target="_blank" rel="noreferrer">
            Decision record {Icon.external(16)}
          </a>
        ) : null}
        <a className="c-link" href={q.question_url} target="_blank" rel="noreferrer">
          Question on GitHub {Icon.external(16)}
        </a>
      </div>
    </li>
  );
}

export function Questions() {
  return (
    <Screen
      screen="questions"
      narrow
      skeleton={
        <div className="c-list" aria-busy="true">
          {[0, 1, 2].map((k) => (
            <div key={k} className="c-card c-section">
              <Skel h={22} w="45%" />
              <Skel h={18} />
              <Skel h={18} w="80%" />
              <Skel h={44} w={180} />
            </div>
          ))}
        </div>
      }
    >
      {(s, now) => {
        const open = s.questions
          .filter((q) => q.status !== "answered")
          .sort((a, b) => b.asked_at.localeCompare(a.asked_at));
        const done = s.questions
          .filter((q) => q.status === "answered")
          .sort((a, b) => (b.answered_at ?? "").localeCompare(a.answered_at ?? ""));
        if (!open.length && !done.length) {
          return (
            <Empty icon={Icon.inbox(24)} title="No questions">
              The system has nothing to ask you. Questions it raises appear here and on Telegram, and answered ones stay
              listed with their decision.
            </Empty>
          );
        }
        return (
          <>
            <section className="c-section" aria-label="Open">
              <div className="c-section-head">
                <h2>Open · {open.length}</h2>
              </div>
              <ul className="c-list">
                {open.map((q) => (
                  <OpenQuestion key={q.question_comment_id} q={q} now={now} repo={s.repo} />
                ))}
              </ul>
            </section>
            <section className="c-section" aria-label="Answered">
              <div className="c-section-head">
                <h2>Answered</h2>
                <span className="c-sm c-muted">newest first</span>
              </div>
              <ul className="c-list">
                {done.map((q) => (
                  <AnsweredQuestion key={q.question_comment_id} q={q} now={now} repo={s.repo} />
                ))}
              </ul>
            </section>
          </>
        );
      }}
    </Screen>
  );
}
