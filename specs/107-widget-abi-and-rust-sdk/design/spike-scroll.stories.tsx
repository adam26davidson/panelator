// spike-scroll (spec 107 section 6, AC-17): the 128 by 16 layer at 60 Hz with the text `panelator 60 Hz`.
// States: entering (the text partly in at the right edge) and leaving (partly out at the left).
import { Color, Mono, Name, Note, type Row, Section, Sheet, Shot, Table } from "./spike-kit.tsx";
import { SCROLL, newLayer, onBlack, scrollColorIndex, scrollX, textWidth, updateScroll, xorshift32 } from "./spike-pixels.ts";

export default { title: "spike-scroll" };

const TEXT = "panelator 60 Hz";
const SEED = 2;
const W = SCROLL.size.w;
const TEXT_W = textWidth(SCROLL.font, TEXT);
const PERIOD = W + TEXT_W;
// entering: the first pass, 52 pixels in. leaving: the third pass (the first with a new colour), 52 pixels out.
const STATES = { entering: 52, leaving: 2 * PERIOD + 180 } as const;
type State = keyof typeof STATES;

function ScrollShot({ state }: { state: State }) {
  const tick = STATES[state];
  const index = scrollColorIndex(SEED, tick, W, TEXT);
  const x = scrollX(tick, W, TEXT);
  const layer = newLayer(W, SCROLL.size.h);
  updateScroll(layer, tick, TEXT, index);
  const shown = x >= 0 ? `${W - x} of its ${TEXT_W} pixels are in` : `${-x} of its ${TEXT_W} pixels are out`;
  return (
    <Shot
      title={state}
      meta={`Tick ${tick}, seed ${SEED}: text at x = ${x}, so ${shown}. Colour ${index}, ${SCROLL.palette[index].name}.`}
      frame={onBlack(layer)}
      alt={`The scroll layer with the text ${TEXT} ${state} in ${SCROLL.palette[index].name} on dark blue`}
    />
  );
}

const ELEMENTS: Row[] = [
  [
    <Name name="1. Background"><Mono>draw_fill</Mono></Name>,
    <Mono>the whole layer</Mono>,
    <Color color={SCROLL.background} name="navy, opaque" />,
  ],
  [
    <Name name="2. Text"><Mono>draw_text</Mono>, font 2 (Spleen 8x16), the config's <Mono>text</Mono></Name>,
    <>
      <Mono>x = W − (tick % (W + text width))</Mono>
      <Mono>y = (H − font height) / 2</Mono>
      <Note>
        W and H are the layer's size. At the declared 128 by 16, y is 0 and the cells fill the height.
        The text here, "{TEXT}", is {TEXT_W} wide, so a pass takes {PERIOD} ticks.
      </Note>
    </>,
    <>
      <Mono>palette[random_u32() % 6]</Mono>
      <Note>Picked at pn_init and again at each later tick where the text re-enters (x = W).</Note>
    </>,
  ],
];

const PICKS = xorshift32(SEED, 3);
const PALETTE: Row[] = SCROLL.palette.map((p, i) => [
  <Name name={`Colour ${i}`}>{p.name}</Name>,
  <Note>
    {PICKS.some((v) => v % 6 === i)
      ? `With seed ${SEED}: ${PICKS.map((v, n) => (v % 6 === i ? `pass ${n + 1}` : "")).filter(Boolean).join(", ")}.`
      : `Not among the first three picks of seed ${SEED}.`}
  </Note>,
  <Color color={p.color} name={p.name} />,
]);

function Screen({ states, state }: { states: State[]; state?: State }) {
  return (
    <Sheet
      screen="spike-scroll"
      state={state}
      lead="The 128 by 16 layer, updated at 60 Hz. Every update fills the layer with the background and draws the text one pixel further left, so it enters at the right edge and leaves at the left. The text moves by the widget's own code: this is the spike's 60 Hz load."
      shots={states.map((s) => <ScrollShot key={s} state={s} />)}
    >
      <Section title="Elements, in draw order">
        <Table head={["Element", "Layer pixels", "Colour"]} rows={ELEMENTS} />
      </Section>
      <Section title="The six text colours, in order">
        <Table head={["Index", "When", "Colour"]} rows={PALETTE} />
        <p className="s-sm s-muted">
          Each is at least 6.8 to 1 against the background and 8.7 to 1 against black.
        </p>
      </Section>
    </Sheet>
  );
}

export const Default = () => <Screen states={["entering", "leaving"]} />;
export const Entering = () => <Screen states={["entering"]} state="entering" />;
export const Leaving = () => <Screen states={["leaving"]} state="leaving" />;
