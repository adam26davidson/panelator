/** The one table of spec 051 AC-6: the latest snapshot, the change queue with outcomes, sessions and sign-in attempts. */
export interface ChangeRow {
  id: number;
  at: string;
  by: string;
  kind: string;
  args: Record<string, unknown>;
  result?: { status: string; action_id?: string; reason?: string };
}
export interface Session {
  id: string;
  login: string;
  expires_at: number;
}

export interface Table {
  putState(snapshot: unknown, at: number): Promise<void>;
  getState(): Promise<{ snapshot: unknown; at: number } | null>;
  /** Appends with the next increasing id. */
  /** The id is `max(last id + 1, now in ms)`, so a table made later never reuses the range of an earlier one. */
  addChange(c: Omit<ChangeRow, "id">, now: number): Promise<ChangeRow>;
  changesAfter(after: number): Promise<ChangeRow[]>;
  setResult(id: number, result: NonNullable<ChangeRow["result"]>): Promise<boolean>;
  putSession(s: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  recordAttempt(a: { login: string | null; ok: boolean; reason?: string; at: number }): Promise<void>;
}

export class MemoryTable implements Table {
  state: { snapshot: unknown; at: number } | null = null;
  changes: ChangeRow[] = [];
  sessions = new Map<string, Session>();
  attempts: { login: string | null; ok: boolean; reason?: string; at: number }[] = [];
  async putState(snapshot: unknown, at: number) {
    this.state = { snapshot, at };
  }
  async getState() {
    return this.state;
  }
  async addChange(c: Omit<ChangeRow, "id">, now: number) {
    const row = { ...c, id: Math.max((this.changes.at(-1)?.id ?? 0) + 1, now) };
    this.changes.push(row);
    return row;
  }
  async changesAfter(after: number) {
    return this.changes.filter((c) => c.id > after);
  }
  async setResult(id: number, result: NonNullable<ChangeRow["result"]>) {
    const c = this.changes.find((x) => x.id === id);
    if (!c) return false;
    c.result = result;
    return true;
  }
  async putSession(s: Session) {
    this.sessions.set(s.id, s);
  }
  async getSession(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
  async recordAttempt(a: { login: string | null; ok: boolean; reason?: string; at: number }) {
    this.attempts.push(a);
  }
}

/** The subset of the DynamoDB client the table uses, so tests need no SDK. */
export interface Dynamo {
  send(command: unknown): Promise<Record<string, unknown>>;
}

type Ctor = new (input: Record<string, unknown>) => unknown;
/** The SDK's command classes, passed in so this file imports no SDK. */
export interface Commands {
  Put: Ctor;
  Get: Ctor;
  Delete: Ctor;
  Query: Ctor;
  Update: Ctor;
}
type Item = Record<string, { S?: string; N?: string }>;
const s = (v: string) => ({ S: v });
const n = (v: number) => ({ N: String(v) });

/** Single-table layout: pk = "state" | "change" | "session#<id>" | "attempt#<ts>", sk = zero-padded id for changes. */
export class DynamoTable implements Table {
  private db: Dynamo;
  private name: string;
  private cmd: Commands;
  constructor(db: Dynamo, name: string, cmd: Commands) {
    this.db = db;
    this.name = name;
    this.cmd = cmd;
  }
  private put(item: Item) {
    return this.db.send(new this.cmd.Put({ TableName: this.name, Item: item }));
  }
  async putState(snapshot: unknown, at: number) {
    await this.put({ pk: s("state"), sk: s("0"), body: s(JSON.stringify(snapshot)), at: n(at) });
  }
  async getState() {
    const r = (await this.db.send(
      new this.cmd.Get({ TableName: this.name, Key: { pk: s("state"), sk: s("0") }, ConsistentRead: true }),
    )) as { Item?: Item };
    return r.Item ? { snapshot: JSON.parse(r.Item.body.S as string), at: Number(r.Item.at.N) } : null;
  }
  async addChange(c: Omit<ChangeRow, "id">, now: number) {
    for (;;) {
      const cur = (await this.db.send(
        new this.cmd.Get({ TableName: this.name, Key: { pk: s("counter"), sk: s("0") }, ConsistentRead: true }),
      )) as { Item?: Item };
      const last = cur.Item ? Number(cur.Item.v.N) : 0;
      const id = Math.max(last + 1, now);
      try {
        await this.db.send(
          new this.cmd.Update({
            TableName: this.name,
            Key: { pk: s("counter"), sk: s("0") },
            UpdateExpression: "SET v = :new",
            ConditionExpression: cur.Item ? "v = :old" : "attribute_not_exists(v)",
            ExpressionAttributeValues: { ":new": n(id), ...(cur.Item ? { ":old": n(last) } : {}) },
          }),
        );
      } catch (e) {
        if ((e as { name?: string }).name === "ConditionalCheckFailedException") continue;
        throw e;
      }
      await this.put({ pk: s("change"), sk: s(String(id).padStart(12, "0")), body: s(JSON.stringify({ ...c, id })) });
      return { ...c, id };
    }
  }
  async changesAfter(after: number) {
    const r = (await this.db.send(
      new this.cmd.Query({
        TableName: this.name,
        KeyConditionExpression: "pk = :p AND sk > :k",
        ExpressionAttributeValues: { ":p": s("change"), ":k": s(String(after).padStart(12, "0")) },
        ConsistentRead: true,
      }),
    )) as { Items?: Item[] };
    return (r.Items ?? []).map((i) => JSON.parse(i.body.S as string) as ChangeRow);
  }
  async setResult(id: number, result: NonNullable<ChangeRow["result"]>) {
    const key = { pk: s("change"), sk: s(String(id).padStart(12, "0")) };
    const r = (await this.db.send(new this.cmd.Get({ TableName: this.name, Key: key, ConsistentRead: true }))) as {
      Item?: Item;
    };
    if (!r.Item) return false;
    await this.put({ ...key, body: s(JSON.stringify({ ...JSON.parse(r.Item.body.S as string), result })) });
    return true;
  }
  async putSession(x: Session) {
    await this.put({
      pk: s(`session#${x.id}`),
      sk: s("0"),
      body: s(JSON.stringify(x)),
      ttl: n(Math.floor(x.expires_at / 1000)),
    });
  }
  async getSession(id: string) {
    const r = (await this.db.send(
      new this.cmd.Get({ TableName: this.name, Key: { pk: s(`session#${id}`), sk: s("0") } }),
    )) as { Item?: Item };
    return r.Item ? (JSON.parse(r.Item.body.S as string) as Session) : null;
  }
  async deleteSession(id: string) {
    await this.db.send(new this.cmd.Delete({ TableName: this.name, Key: { pk: s(`session#${id}`), sk: s("0") } }));
  }
  async recordAttempt(a: { login: string | null; ok: boolean; reason?: string; at: number }) {
    await this.put({
      pk: s(`attempt#${a.at}`),
      sk: s(String(Math.random())),
      body: s(JSON.stringify(a)),
      ttl: n(Math.floor(a.at / 1000) + 90 * 86400),
    });
  }
}
