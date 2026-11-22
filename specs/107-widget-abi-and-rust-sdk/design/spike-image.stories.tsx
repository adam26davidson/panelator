// spike-image (spec 107 section 6, AC-17): the 128 by 64 layer at 30 Hz showing AC-12's image.
// States: offset-0 (the asset as it is) and offset-40 (the wrap visible).
import { Color, Mono, Name, Note, type Row, Section, Sheet, Shot, Table } from "./spike-kit.tsx";
import { IMAGE, imageOffset, newLayer, onBlack, spikeImageAsset, updateImage } from "./spike-pixels.ts";

export default { title: "spike-image" };

const W = IMAGE.size.w;
// offset-0 is tick 0 of scene `spike-image`; offset-40 is tick 80 (o = (tick / 2) % W).
const STATES = { "offset-0": 0, "offset-40": 80 } as const;
type State = keyof typeof STATES;

function ImageShot({ state }: { state: State }) {
  const tick = STATES[state];
  const o = imageOffset(tick, W);
  const layer = newLayer(W, IMAGE.size.h);
  updateImage(layer, tick, spikeImageAsset());
  return (
    <Shot
      title={state}
      meta={
        o === 0
          ? `Tick ${tick}: o = 0. The first blit covers the layer; the second, at x = ${W}, is wholly clipped.`
          : `Tick ${tick}: o = ${o}. Blits at x = ${-o} and x = ${W - o}; the image's left edge is at column ${W - o}.`
      }
      frame={onBlack(layer)}
      alt={`The image layer: a red and green gradient with a blue checkerboard, shifted left by ${o} pixels`}
    />
  );
}

const ELEMENTS: Row[] = [
  [
    <Name name="1. First blit"><Mono>draw_image</Mono>, the config's <Mono>asset</Mono>, frame 0</Name>,
    <>
      <Mono>x = −o, y = 0</Mono>
      <Note>o = (tick / 2) % W, W the layer's width: one pixel left every update.</Note>
    </>,
    <Note>The asset's pixels, each at alpha 255.</Note>,
  ],
  [
    <Name name="2. Second blit"><Mono>draw_image</Mono>, the same asset and frame</Name>,
    <>
      <Mono>x = W − o, y = 0</Mono>
      <Note>The wrap: what the first blit pushed out at the left comes in at the right.</Note>
    </>,
    <Note>The asset's pixels, each at alpha 255.</Note>,
  ],
  [
    <Name name="Failure"><Mono>draw_fill</Mono>, when either blit returns an error</Name>,
    <Mono>the whole layer</Mono>,
    <Color color={IMAGE.failure} name="magenta, opaque" />,
  ],
];

const ASSET: Row[] = [
  [<Name name="Red" />, <Mono>(x × 255) / 127</Mono>, <Note>0 at the left edge, 255 at the right.</Note>],
  [<Name name="Green" />, <Mono>(y × 255) / 63</Mono>, <Note>0 at the top, 255 at the bottom.</Note>],
  [
    <Name name="Blue" />,
    <Mono>255 when (x / 8 + y / 8) is even, else 0</Mono>,
    <Note>A checkerboard of 8-pixel squares, so a shift of one pixel shows.</Note>,
  ],
];

function Screen({ states, state }: { states: State[]; state?: State }) {
  return (
    <Sheet
      screen="spike-image"
      state={state}
      lead="The 128 by 64 layer, updated at 30 Hz. Every update blits the whole 24 KB asset twice, one pixel further left than the last, so the image wraps. The widget draws nothing else: every pixel is the asset's."
      shots={states.map((s) => <ImageShot key={s} state={s} />)}
    >
      <Section title="Elements, in draw order">
        <Table head={["Element", "Layer pixels", "Colour"]} rows={ELEMENTS} />
      </Section>
      <Section title="The asset, spike-image (128 by 64, one frame)">
        <Table head={["Channel", "Value at (x, y)", "Reads as"]} rows={ASSET} />
      </Section>
    </Sheet>
  );
}

export const Default = () => <Screen states={["offset-0", "offset-40"]} />;
export const Offset0 = () => <Screen states={["offset-0"]} state="offset-0" />;
export const Offset40 = () => <Screen states={["offset-40"]} state="offset-40" />;
