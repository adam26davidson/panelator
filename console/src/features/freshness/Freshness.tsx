import { useConsole } from "../../app/ConsoleProvider.tsx";
import { age, ago, clock } from "../../shared/lib/format.ts";

export function FreshnessChip() {
  const { view } = useConsole();
  if (view.status === "ready") {
    if (view.fresh === "stale")
      return (
        <span className="c-fresh stale">
          <span className="c-dot" />
          Stale · {age(view.ageS)}
        </span>
      );
    if (view.fresh === "offline")
      return (
        <span className="c-fresh offline">
          <span className="c-dot" />
          Offline · {age(view.ageS)}
        </span>
      );
    return (
      <span className="c-fresh">
        <span className="c-dot" />
        Updated {Math.round(view.ageS)} s ago
      </span>
    );
  }
  if (view.fresh === "offline")
    return (
      <span className="c-fresh offline">
        <span className="c-dot" />
        Offline
      </span>
    );
  return (
    <span className="c-fresh loading">
      <span className="c-spin" />
      Loading
    </span>
  );
}

export function FreshnessBanner() {
  const { view, refetch } = useConsole();
  if (view.fresh === "offline") {
    return (
      <div className="c-alert offline" role="alert">
        <div>
          <strong>Can't reach the console API</strong>
          {view.status === "ready"
            ? `Showing the last snapshot it sent (${clock(view.snapshot.generated_at)}, ${ago(view.snapshot.generated_at, view.now)}). `
            : "No snapshot yet. "}
          Retrying every 10 s. Changes are off until it is back.
        </div>
        <button type="button" className="c-btn" onClick={refetch}>
          Retry now
        </button>
      </div>
    );
  }
  if (view.status === "ready" && view.fresh === "stale") {
    return (
      <div className="c-alert stale" role="status">
        <div>
          <strong>This snapshot is {Math.round(view.ageS / 60)} minutes old</strong>
          The scheduler pushes at least every {view.snapshot.tick_s} s, so it may be stopped or offline. Shown as of{" "}
          {clock(view.snapshot.generated_at)}. Changes you make wait in the queue until it reconnects.
        </div>
      </div>
    );
  }
  return null;
}
