// Home (spec 112 AC-7, section 7): the frame, one heading and a short statement of what panelator
// is. No control and no link beyond the name in the frame; no states.
import { Frame, PageHeading, ReadingColumn } from "./web-kit.tsx";

export default { title: "home" };

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

export const Default = () => (
  <Frame>
    <ReadingColumn>
      <PageHeading
        eyebrow="Open-source LED dashboard"
        title="An LED dashboard you configure yourself"
        lead="panelator is an LED panel that renders its own screens, and a web app to build those screens from widgets, preview them and control the board."
      />
      <dl className="p-parts">
        {PARTS.map((p) => (
          <div key={p.term} className="p-part">
            <dt>{p.term}</dt>
            <dd>{p.text}</dd>
          </div>
        ))}
      </dl>
      <p className="p-status">
        <strong>Under construction.</strong> The editor, the simulator and board control are not in this app yet.
      </p>
    </ReadingColumn>
  </Frame>
);
