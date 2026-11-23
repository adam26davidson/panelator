export type HeadingTone = "neutral" | "danger";

/** Eyebrow, the screen's one `h1` (focusable by script) and the lead, stacked with one gap between each pair. */
export function PageHeading(props: { eyebrow: string; title: string; lead: string; tone?: HeadingTone }) {
  return (
    <div className="flex flex-col gap-3">
      <p
        className={`text-sm font-semibold tracking-wide uppercase ${props.tone === "danger" ? "text-danger" : "text-muted"}`}
      >
        {props.eyebrow}
      </p>
      <h1 tabIndex={-1} className="text-balance text-xl font-bold leading-tight tablet:text-2xl">
        {props.title}
      </h1>
      <p className="text-base leading-normal text-text tablet:text-lg">{props.lead}</p>
    </div>
  );
}
