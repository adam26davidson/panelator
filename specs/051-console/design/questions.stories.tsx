// Questions (spec 051 AC-9): open first, then answered; each links to its GitHub comment, the Telegram chat
// when the poller has reported the bot's username, and the decision record once answered.
import { ANSWERED, Empty, type Freshness, Icon, QUESTIONS, Shell, SignIn, Skel } from "./console-kit.tsx";

export default { title: "questions" };

const KIND_TONE: Record<string, string> = { product: "violet", technical: "accent", capability: "warn" };

function OpenQuestion({ q, telegram }: { q: (typeof QUESTIONS)[number]; telegram: boolean }) {
  return (
    <li className="c-card c-section" style={{ gap: 12 }}>
      <div className="c-wrap">
        <a className="c-link" style={{ minWidth: 44, fontSize: "var(--text-base)" }} href={`#issue-${q.issue}`}>#{q.issue}</a>
        <span className={`c-badge ${KIND_TONE[q.kind]}`}>{q.kind}</span>
        {q.status === "reminded" ? <span className="c-badge warn">Reminded</span> : <span className="c-badge accent">Open</span>}
        <span className="c-sm c-muted">{q.asked}</span>
      </div>
      <p style={{ fontSize: "var(--text-base)", fontWeight: 600 }}>{q.text}</p>
      <ol className="c-list" style={{ gap: 8 }}>
        {q.options.map((o, i) => (
          <li key={o.label} className="c-row" style={{ alignItems: "flex-start", gap: 10 }}>
            <span className="c-badge" style={{ minWidth: 30, justifyContent: "center" }}>{i + 1}</span>
            <span>
              <span className="c-strong">{o.label}</span>
              {q.recommendation === o.label ? <span className="c-sm" style={{ color: "var(--color-ok)", fontWeight: 600 }}> · recommended</span> : null}
              <span className="c-sm c-muted" style={{ display: "block" }}>{o.cost}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="c-wrap" style={{ gap: 12 }}>
        <a className="c-btn primary" href={`#gh-${q.id}`}>Answer on GitHub {Icon.external(16)}</a>
        {telegram ? <a className="c-btn" href="#telegram">Open Telegram chat {Icon.external(16)}</a> : null}
      </div>
    </li>
  );
}

function AnsweredQuestion({ q }: { q: (typeof ANSWERED)[number] }) {
  return (
    <li className="c-card c-section" style={{ gap: 8 }}>
      <div className="c-wrap">
        <a className="c-link" style={{ minWidth: 44, fontSize: "var(--text-base)" }} href={`#issue-${q.issue}`}>#{q.issue}</a>
        <span className={`c-badge ${KIND_TONE[q.kind]}`}>{q.kind}</span>
        <span className="c-badge ok">{Icon.check(14)} Answered</span>
        <span className="c-sm c-muted">{q.answered}</span>
      </div>
      <p>{q.text}</p>
      <div className="c-wrap" style={{ gap: 16 }}>
        <a className="c-link" href={`#decision-${q.id}`}>Decision record {Icon.external(16)}</a>
        <a className="c-link" href={`#gh-${q.id}`}>Question on GitHub {Icon.external(16)}</a>
      </div>
    </li>
  );
}

function Questions({ fresh = "fresh", telegram = true }: { fresh?: Freshness; telegram?: boolean }) {
  return (
    <Shell screen="questions" fresh={fresh} narrow>
      <section className="c-section" aria-label="Open">
        <div className="c-section-head"><h2>Open · {QUESTIONS.length}</h2></div>
        <ul className="c-list">{QUESTIONS.map((q) => <OpenQuestion key={q.id} q={q} telegram={telegram} />)}</ul>
      </section>
      <section className="c-section" aria-label="Answered">
        <div className="c-section-head"><h2>Answered</h2><span className="c-sm c-muted">newest first</span></div>
        <ul className="c-list">{ANSWERED.map((q) => <AnsweredQuestion key={q.id} q={q} />)}</ul>
      </section>
    </Shell>
  );
}

export const Default = () => <Questions />;
/** Telegram poller not connected: no telegram_url, so only GitHub links. */
export const NoTelegram = () => <Questions telegram={false} />;
export const Loading = () => (
  <Shell screen="questions" fresh="loading" openQuestions={0} narrow>
    <div className="c-list" aria-busy="true">
      {[0, 1, 2].map((k) => (
        <div key={k} className="c-card c-section"><Skel h={22} w="45%" /><Skel h={18} /><Skel h={18} w="80%" /><Skel h={44} w={180} /></div>
      ))}
    </div>
  </Shell>
);
export const Stale = () => <Questions fresh="stale" />;
export const Unreachable = () => <Questions fresh="offline" />;
export const SignedOut = () => <SignIn screen="questions" />;
export const Empty_ = () => (
  <Shell screen="questions" openQuestions={0} narrow>
    <Empty icon={Icon.inbox(24)} title="No questions">
      The system has nothing to ask you. Questions it raises appear here and on Telegram, and answered ones stay listed with their decision.
    </Empty>
  </Shell>
);
Empty_.storyName = "Empty";
