import { ButtonLink, PageHeading, ReadingColumn } from "@/shared/ui";

const PARTS = [
  {
    term: "The panel",
    text: "An LED panel driven by a small board. The board draws every screen itself and keeps showing the last one you applied, with or without this app.",
  },
  {
    term: "The web app",
    text: "Build screens from widgets by drag and drop, preview them in a simulator that runs the same widget code as the board, and control the board live.",
  },
  {
    term: "Open source",
    text: "Firmware, backend, web app and hardware are open. You can host all of it yourself.",
  },
];

export function HomePage() {
  return (
    <ReadingColumn>
      <title>panelator</title>
      <PageHeading
        eyebrow="Open-source LED dashboard"
        title="An LED dashboard you configure yourself"
        lead="panelator is an LED panel that renders its own screens, and a web app to build those screens from widgets, preview them and control the board."
      />
      <dl className="flex flex-col border-t-(length:--line) border-border">
        {PARTS.map((p) => (
          <div
            key={p.term}
            className="flex flex-col gap-1 border-b-(length:--line) border-border py-4 tablet:flex-row tablet:gap-6"
          >
            <dt className="font-semibold tablet:w-term tablet:flex-none">{p.term}</dt>
            <dd className="text-muted">{p.text}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-4 rounded-md border-(length:--line) border-border bg-surface p-4">
        <p className="text-muted">
          <strong className="font-semibold text-text">Under construction.</strong> The editor and board control are not
          in this app yet. The simulator page runs the runtime spike's three widgets.
        </p>
        <div className="flex flex-col tablet:flex-row">
          <ButtonLink variant="primary" to="/simulator">
            Open the simulator
          </ButtonLink>
        </div>
      </div>
    </ReadingColumn>
  );
}
