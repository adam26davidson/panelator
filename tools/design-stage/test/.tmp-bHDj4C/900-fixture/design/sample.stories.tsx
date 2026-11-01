import type { Meta, StoryObj } from "@storybook/react-vite";

function Sample({ items }: { items: string[] }) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl" style={{ color: "var(--color-accent)" }}>
        Sample screen
      </h1>
      {items.length === 0 ? (
        <p className="mt-4 text-base" style={{ color: "var(--color-text-muted)" }}>
          Nothing here yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <li key={item} className="rounded-md border p-4 text-base" style={{ borderColor: "var(--color-border)" }}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const meta: Meta<typeof Sample> = { title: "fixture/sample", component: Sample };
export default meta;

export const Default: StoryObj<typeof Sample> = { args: { items: ["one", "two", "three"] } };
export const Empty: StoryObj<typeof Sample> = { args: { items: [] } };
