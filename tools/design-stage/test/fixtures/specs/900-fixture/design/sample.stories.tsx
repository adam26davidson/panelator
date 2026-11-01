export default { title: "sample" };

export const Default = () => (
  <main className="p-6" style={{ background: "var(--color-surface)" }}>
    <h1 className="text-2xl font-bold">Sample</h1>
    <p style={{ color: "var(--color-muted)" }}>Three cards.</p>
    <ul className="grid gap-4 md:grid-cols-3">
      {["one", "two", "three"].map((n) => (
        <li key={n} className="rounded-lg p-4" style={{ background: "var(--color-bg)" }}>
          {n}
        </li>
      ))}
    </ul>
  </main>
);

export const Empty = () => (
  <main className="p-6">
    <p style={{ color: "var(--color-muted)" }}>Nothing here yet.</p>
  </main>
);
