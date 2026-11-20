import { describe, it, expect, afterEach } from "vitest";
import { startTelegram } from "../src/service/telegram-start.ts";
import { CredentialStore } from "../src/credentials/store.ts";
import { loadConfig, defaultConfigPath } from "../src/config.ts";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTelegramCredentials } from "../src/telegram/credentials.ts";
import { TelegramApiError, TelegramClient, isAuthError } from "../src/telegram/client.ts";
import { UpdateDeferred } from "../src/telegram/answers.ts";
import { TelegramPoller } from "../src/telegram/poller.ts";
import { fakeTelegram } from "./helpers/fake-telegram.ts";
import {
  ackText,
  questionMessage,
  matchUpdate,
} from "../src/telegram/questions.ts";
import { initialChainState } from "../src/chain/machine.ts";
import { emptyTelegram, type PausedRecord } from "../src/state/paused.ts";
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(f()).toBe(true);
};
describe("Telegram", () => {
  it("matches free text, pending choices, question lists, and ignores stale or edited replies", () => {
    const r: PausedRecord = {
      issue: 7,
      phase: "paused",
      nonce: "a",
      state: initialChainState(7),
      question: {
        kind: "product",
        question: "Choose?",
        options: [{ label: "one", cost: "none" }],
        recommendation: "one",
      },
      asking_stage: "plan",
      question_comment_id: 1,
      asked_at: new Date(10000).toISOString(),
      reminded: false,
      answer: null,
      reply_comment_id: null,
      telegram: {
        ...emptyTelegram(),
        sent: true,
        message_id: 10,
        sent_at: new Date(10000).toISOString(),
        thread_message_ids: [10, 11],
        reminder_message_id: 12,
      },
    };
    const other = { ...r, issue: 8, nonce: "b" };
    const m = { message_id: 20, date: 11, chat: { id: 42 }, text: "one" };
    const update = { update_id: 1, message: m };
    expect(matchUpdate(update, [r], null).kind).toBe("answer");
    expect(matchUpdate(update, [r, other], null)).toEqual({
      kind: "list",
      text: "one",
    });
    expect(
      matchUpdate(
        { ...update, message: { ...m, text: "/questions" } },
        [],
        null,
      ).kind,
    ).toBe("questions");
    expect(matchUpdate(update, [], null).kind).toBe("none");
    expect(
      matchUpdate({ update_id: 1, edited_message: m }, [r], null).kind,
    ).toBe("ignore");
    expect(
      matchUpdate({ ...update, message: { ...m, date: 1 } }, [r], null).kind,
    ).toBe("ignore");
    for (const id of [10, 11, 12])
      expect(
        matchUpdate(
          {
            ...update,
            message: { ...m, reply_to_message: { message_id: id } },
          },
          [r, other],
          null,
        ).kind,
      ).toBe("answer");
    expect(
      matchUpdate(
        {
          ...update,
          message: { ...m, text: "#8", reply_to_message: { message_id: 30 } },
        },
        [r, other],
        { list_message_id: 30, text: "original answer", at: "" },
      ),
    ).toMatchObject({
      kind: "pick",
      record: { issue: 8 },
      text: "original answer",
    });
    expect(() =>
      questionMessage(
        { number: 7, title: "title" },
        { ...r, nonce: "x".repeat(65) },
        "url",
      ),
    ).toThrow("too long");
  });
  it("confirms foreign chats without reading their text and logs each chat once", async () => {
    const server = await fakeTelegram();
    const dir = await mkdtemp(join(tmpdir(), "foreign-"));
    const logs: Record<string, unknown>[] = [];
    let handled = 0;
    const poll = new TelegramPoller(
      new TelegramClient("secret", 42, server.url),
      join(dir, "offset.json"),
      50,
      async () => {
        handled++;
      },
      (r) => logs.push(r),
    );
    poll.start();
    try {
      await until(() => server.requests.length === 2);
      for (const id of [1, 2])
        server.push({
          update_id: id,
          message: {
            message_id: id,
            date: 1,
            chat: { id: 99 },
            text: "PRIVATE TEXT",
          },
        });
      await until(() => server.requests.some((r) => r.body.offset === 3));
      expect(handled).toBe(0);
      expect(logs).toEqual([
        { kind: "telegram", status: "connected", username: "test_bot" },
        { kind: "telegram-foreign-chat", chat_id: 99 },
      ]);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE");
    } finally {
      await poll.stop();
      await server.close();
    }
  });
  it("backs off network/server failures, logs one outage and recovery, and stop preserves the offset", async () => {
    const server = await fakeTelegram();
    const dir = await mkdtemp(join(tmpdir(), "outage-"));
    const logs: Record<string, unknown>[] = [];
    const waits: number[] = [];
    let failures = 0;
    const client = new TelegramClient("secret", 42, server.url);
    const get = client.getUpdates.bind(client);
    client.getUpdates = (opts) => {
      if (failures++ < 8) return Promise.reject(Error("secret URL"));
      return get(opts);
    };
    const poll = new TelegramPoller(
      client,
      join(dir, "offset.json"),
      50,
      async () => {},
      (r) => logs.push(r),
      async (ms) => {
        waits.push(ms);
      },
    );
    poll.start();
    try {
      await until(() => server.requests.length === 2);
      expect(waits).toEqual([
        1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
      ]);
      server.push({
        update_id: 4,
        message: { message_id: 1, date: 1, chat: { id: 42 }, text: "ok" },
      });
      await until(() => server.requests.length === 3);
      expect(logs).toEqual([
        { kind: "telegram", status: "connected", username: "test_bot" },
        { kind: "telegram-outage" },
        { kind: "telegram-recovered" },
      ]);
      await poll.stop();
      expect(
        JSON.parse(await readFile(join(dir, "offset.json"), "utf8")),
      ).toEqual({ next_update_id: 5 });
    } finally {
      await poll.stop();
      await server.close();
    }
  });
  it("credentials fail closed without exposing values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-"));
    const p = join(dir, "credentials");
    expect(await readTelegramCredentials(p)).toHaveProperty("off");
    await writeFile(p, JSON.stringify({ bot_token: "secret", chat_id: "bad" }));
    expect(JSON.stringify(await readTelegramCredentials(p))).not.toContain(
      "secret",
    );
    await writeFile(p, JSON.stringify({ bot_token: "secret", chat_id: 42 }));
    expect(await readTelegramCredentials(p)).toEqual({
      bot_token: "secret",
      chat_id: 42,
    });
  });
  it("client sends and sanitizes errors", async () => {
    const server = await fakeTelegram();
    try {
      const c = new TelegramClient("secret", 42, server.url);
      expect((await c.getMe()).username).toBe("test_bot");
      expect(await c.sendMessage({ text: "hello" })).toBe(1);
      server.fail("getMe", 401);
      await expect(c.getMe()).rejects.not.toThrow("secret");
    } finally {
      await server.close();
    }
  });
  it("spec 089 AC-1, AC-2: only a Bot API 401 or 404 is an authorization error", async () => {
    const server = await fakeTelegram();
    try {
      const c = new TelegramClient("secret", 42, server.url);
      const fail = async (code: number, body?: string) => {
        server.fail("getMe", code, 1, body);
        const e = await c.getMe().then(
          () => undefined,
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(TelegramApiError);
        expect(JSON.stringify(e) + String((e as Error).message)).not.toContain("secret");
        return e as TelegramApiError;
      };
      for (const code of [401, 404]) {
        const e = await fail(code);
        expect(e.error_code).toBe(code);
        expect(e.bot_api).toBe(true);
        expect(isAuthError(e)).toBe(true);
      }
      for (const [code, body, description] of [
        [401, "<html>portal</html>", "invalid response"],
        [404, "<html>portal</html>", "invalid response"],
        [404, "null", "invalid response"],
        [404, "{}", "request failed"],
      ] as const) {
        const e = await fail(code, body);
        expect(e.error_code).toBe(code);
        expect(e.description).toBe(description);
        expect(e.bot_api).toBe(false);
        expect(isAuthError(e)).toBe(false);
      }
    } finally {
      await server.close();
    }
  });
  it("holds one request; confirms only after effects; redelivers on failure; aborts", async () => {
    const server = await fakeTelegram();
    const dir = await mkdtemp(join(tmpdir(), "poll-"));
    let handled = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const logs: unknown[] = [];
    const poll = new TelegramPoller(
      new TelegramClient("secret", 42, server.url),
      join(dir, "offset.json"),
      50,
      async () => {
        handled++;
        if (handled === 1) throw Error("interrupted");
        await gate;
      },
      (r) => logs.push(r),
      async () => {},
    );
    poll.start();
    try {
      await until(() => server.requests.length === 2);
      server.push({
        update_id: 8,
        message: {
          message_id: 1,
          date: Date.now() / 1000,
          chat: { id: 42 },
          text: "yes",
        },
      });
      await until(() => handled === 2);
      await expect(
        readFile(join(dir, "offset.json"), "utf8"),
      ).rejects.toThrow();
      release();
      await until(() => server.requests.length >= 4);
      expect(
        JSON.parse(await readFile(join(dir, "offset.json"), "utf8"))
          .next_update_id,
      ).toBe(9);
    } finally {
      await poll.stop();
      await server.close();
    }
  });
  it("formats options, thread matching and delayed acknowledgements", () => {
    const r: PausedRecord = {
      issue: 9,
      phase: "paused",
      state: initialChainState(9),
      nonce: "abc",
      question: {
        kind: "capability",
        question: "Ready?",
        options: [{ label: "yes", cost: "none" }],
        recommendation: "yes",
      },
      asking_stage: "plan",
      question_comment_id: 1,
      asked_at: new Date(0).toISOString(),
      reminded: false,
      answer: null,
      reply_comment_id: null,
      telegram: {
        message_id: 10,
        sent: true,
        sent_at: new Date(0).toISOString(),
        send_failures: 0,
        reminder_message_id: null,
        thread_message_ids: [10, 11],
        thread_last_message_id: 11,
        answer_update_id: null,
        ack_sent: false,
        channel: null,
      },
    };
    expect(
      questionMessage({ number: 9, title: "Test" }, r, "url").reply_markup
        .inline_keyboard[0][0].callback_data,
    ).toBe("q:abc:1");
    expect(
      matchUpdate(
        {
          update_id: 1,
          callback_query: {
            id: "cb",
            data: "q:abc:1",
            message: { message_id: 10, date: 1, chat: { id: 42 } },
          },
        },
        [r],
        null,
      ).kind,
    ).toBe("answer");
    expect(
      matchUpdate(
        {
          update_id: 2,
          message: {
            message_id: 12,
            date: 2,
            chat: { id: 42 },
            reply_to_message: { message_id: 11 },
            text: "ok",
          },
        },
        [r],
        null,
      ).kind,
    ).toBe("answer");
    expect(ackText("plan", 9, new Date(0))).toContain("Picked up");
  });
});

const msg = (id: number) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1,
    chat: { id: 42 },
    text: "PRIVATE TEXT",
  },
});
describe("Telegram poller handler failures (spec 042)", () => {
  const rig = async (
    onUpdate: (u: { update_id: number }) => Promise<void>,
    prep?: (client: TelegramClient) => void,
  ) => {
    const server = await fakeTelegram();
    const dir = await mkdtemp(join(tmpdir(), "handler-"));
    const logs: Record<string, unknown>[] = [];
    const waits: number[] = [];
    const client = new TelegramClient("secret", 42, server.url);
    prep?.(client);
    const poll = new TelegramPoller(
      client,
      join(dir, "offset.json"),
      50,
      onUpdate,
      (r) => logs.push(r),
      async (ms) => {
        waits.push(ms);
      },
    );
    const offsetFile = () =>
      readFile(join(dir, "offset.json"), "utf8").then(JSON.parse);
    return { server, poll, logs, waits, offsetFile, dir };
  };
  it("AC-1: logs a handler failure, keeps the offset, waits 2 s, redelivers", async () => {
    let calls = 0;
    const r = await rig(async () => {
      if (calls++ === 0) throw Error("boom");
    });
    r.server.push(msg(1));
    r.poll.start();
    try {
      await until(() => calls === 2);
      await until(() => r.server.requests.some((q) => q.body.offset === 2));
      expect(r.logs).toEqual([
        { kind: "telegram", status: "connected", username: "test_bot" },
        { kind: "telegram-handler-failed", update_id: 1, error: "boom" },
      ]);
      expect(r.waits).toEqual([2000]);
      const asked = r.server.requests.filter((q) => q.method === "getUpdates");
      expect(asked[1].body.offset).toBe(0);
      expect(asked[2].body.offset).toBe(2);
      expect(await r.offsetFile()).toEqual({ next_update_id: 2 });
      const text = JSON.stringify(r.logs);
      for (const x of ["PRIVATE", "42", r.server.url])
        expect(text).not.toContain(x);
    } finally {
      await r.poll.stop();
      await r.server.close();
    }
  });
  it("AC-1: offset file is not written until the redelivery is handled; non-Error is stringified", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((x) => (release = x));
    const r = await rig(async () => {
      if (calls++ === 0) throw "bad";
      await gate;
    });
    r.server.push(msg(1));
    r.poll.start();
    try {
      await until(() => calls === 2);
      expect(r.logs).toEqual([
        { kind: "telegram", status: "connected", username: "test_bot" },
        { kind: "telegram-handler-failed", update_id: 1, error: "bad" },
      ]);
      await expect(r.offsetFile()).rejects.toThrow();
      release();
      await until(() => r.server.requests.some((q) => q.body.offset === 2));
      expect(await r.offsetFile()).toEqual({ next_update_id: 2 });
    } finally {
      release();
      await r.poll.stop();
      await r.server.close();
    }
  });
  it("AC-1: the rest of a failed batch waits for the redelivery", async () => {
    const seen: number[] = [];
    const r = await rig(async (u) => {
      seen.push(u.update_id);
      if (seen.length === 1) throw Error("boom");
    });
    r.server.push(msg(1));
    r.server.push(msg(2));
    r.poll.start();
    try {
      await until(() => r.server.requests.some((q) => q.body.offset === 3));
      expect(seen).toEqual([1, 1, 2]);
      expect(await r.offsetFile()).toEqual({ next_update_id: 3 });
    } finally {
      await r.poll.stop();
      await r.server.close();
    }
  });
  it("AC-2: a deferred update is logged once and not as a failure", async () => {
    let calls = 0;
    const r = await rig(async () => {
      if (calls++ < 2) throw new UpdateDeferred();
    });
    r.server.push(msg(5));
    r.poll.start();
    try {
      await until(() => r.server.requests.some((q) => q.body.offset === 6));
      expect(calls).toBe(3);
      expect(r.logs).toEqual([
        { kind: "telegram", status: "connected", username: "test_bot" },
        { kind: "telegram-update-deferred", update_id: 5 },
      ]);
      expect(r.waits).toEqual([2000, 2000]);
      expect(await r.offsetFile()).toEqual({ next_update_id: 6 });
    } finally {
      await r.poll.stop();
      await r.server.close();
    }
  });
  it("AC-3: recovery is logged before the handler failure; one backoff step plus the fixed wait", async () => {
    let calls = 0;
    const r = await rig(
      async () => {
        if (calls++ === 0) throw Error("boom");
      },
      (client) => {
        const get = client.getUpdates.bind(client);
        let failed = false;
        client.getUpdates = (opts) => {
          if (!failed) {
            failed = true;
            return Promise.reject(Error("down"));
          }
          return get(opts);
        };
      },
    );
    r.server.push(msg(1));
    r.poll.start();
    try {
      await until(() => r.server.requests.some((q) => q.body.offset === 2));
      expect(r.logs).toEqual([
        { kind: "telegram", status: "connected", username: "test_bot" },
        { kind: "telegram-outage" },
        { kind: "telegram-recovered" },
        { kind: "telegram-handler-failed", update_id: 1, error: "boom" },
      ]);
      expect(r.waits).toEqual([1000, 2000]);
    } finally {
      await r.poll.stop();
      await r.server.close();
    }
  });
  it("stop ends the handler wait", async () => {
    const server = await fakeTelegram();
    const dir = await mkdtemp(join(tmpdir(), "handler-"));
    let calls = 0;
    const poll = new TelegramPoller(
      new TelegramClient("secret", 42, server.url),
      join(dir, "offset.json"),
      50,
      async () => {
        calls++;
        throw Error("boom");
      },
      () => {},
    );
    server.push(msg(1));
    poll.start();
    try {
      await until(() => calls === 1);
      const t = Date.now();
      await poll.stop();
      expect(Date.now() - t).toBeLessThan(1500);
    } finally {
      await poll.stop();
      await server.close();
    }
  });
});

describe("Telegram poller connect step (spec 043)", () => {
  const rig = async (
    sleep: ((ms: number) => Promise<void>) | undefined,
    waits: number[] = [],
    onHook?: (n: number) => void | Promise<void>,
  ) => {
    const server = await fakeTelegram();
    const dir = await mkdtemp(join(tmpdir(), "connect-"));
    const logs: Record<string, unknown>[] = [];
    let hook = 0;
    const poll = new TelegramPoller(
      new TelegramClient("PRIVATE-TOKEN", 42, server.url),
      join(dir, "offset.json"),
      50,
      async () => {},
      (r) => logs.push(r),
      sleep && (async (ms) => {
        waits.push(ms);
        await sleep(ms);
      }),
      undefined,
      () => {
        hook++;
        return onHook?.(hook);
      },
    );
    return { server, poll, logs, hook: () => hook };
  };
  const connected = { kind: "telegram", status: "connected", username: "test_bot" };
  it("AC-1: retries getMe with backoff, logs connecting once, then connects", async () => {
    const waits: number[] = [];
    const r = await rig(async () => {}, waits);
    r.server.fail("getMe", 500, 2);
    r.poll.start();
    try {
      await until(() => r.server.requests.some((q) => q.method === "getUpdates"));
      expect(r.logs).toEqual([
        { kind: "telegram", status: "connecting", reason: "getMe: connection failed" },
        connected,
      ]);
      expect(waits).toEqual([1000, 2000]);
      expect(r.hook()).toBe(1);
      expect(r.server.requests.slice(0, 4).map((q) => q.method)).toEqual([
        "getMe", "getMe", "getMe", "getUpdates",
      ]);
      expect(JSON.stringify(r.logs)).not.toContain("PRIVATE-TOKEN");
    } finally {
      await r.poll.stop();
      await r.server.close();
    }
  });
  it("AC-2: an authorization error turns Telegram off, at once or after retries", async () => {
    for (const retry of [false, true]) {
      const holder: { server?: Awaited<ReturnType<typeof fakeTelegram>> } = {};
      const r = await rig(async () => {
        holder.server!.fail("getMe", 401);
      });
      holder.server = r.server;
      r.server.fail("getMe", retry ? 500 : 401);
      r.poll.start();
      try {
        await until(() => r.logs.some((l) => l.status === "off"));
        await r.poll.stop();
        expect(r.logs.filter((l) => l.status === "off")).toEqual([
          { kind: "telegram", status: "off", reason: "getMe: unauthorized" },
        ]);
        expect(r.logs.some((l) => l.status === "connecting")).toBe(retry);
        expect(r.server.requests.some((q) => q.method === "getUpdates")).toBe(false);
        expect(r.hook()).toBe(0);
      } finally {
        await r.poll.stop();
        await r.server.close();
      }
    }
  });
  it("spec 089 AC-3: a non-Bot-API 404 then 401 is retried as connecting", async () => {
    const html = "<html>captive portal</html>";
    const holder: { server?: Awaited<ReturnType<typeof fakeTelegram>> } = {};
    const waits: number[] = [];
    const r = await rig(async () => {
      if (waits.length === 1) holder.server!.fail("getMe", 401, 1, html);
    }, waits);
    holder.server = r.server;
    r.server.fail("getMe", 404, 1, html);
    r.poll.start();
    try {
      await until(() => r.server.requests.some((q) => q.method === "getUpdates"));
      expect(r.logs).toEqual([
        { kind: "telegram", status: "connecting", reason: "getMe: connection failed" },
        connected,
      ]);
      expect(waits).toEqual([1000, 2000]);
      expect(r.hook()).toBe(1);
      expect(r.logs.some((l) => l.status === "off")).toBe(false);
    } finally {
      await r.poll.stop();
      await r.server.close();
    }
  });
  it("AC-1: a stop during the connecting wait issues no getUpdates", async () => {
    const r = await rig(undefined);
    r.server.fail("getMe", 500, 1000);
    r.poll.start();
    try {
      await until(() => r.logs.length === 1);
      const t = Date.now();
      await r.poll.stop();
      expect(Date.now() - t).toBeLessThan(1500);
      expect(r.server.requests.some((q) => q.method === "getUpdates")).toBe(false);
    } finally {
      await r.server.close();
    }
  });
  it("spec 090 AC-1: a rejecting hook is retried alone, without another getMe", async () => {
    const waits: number[] = [];
    const seen: number[] = [];
    const holder: { r?: Awaited<ReturnType<typeof rig>> } = {};
    const r = await rig(async () => {}, waits, async (n) => {
      seen.push(holder.r!.server.requests.length);
      if (n === 1) throw new Error("attach one");
      if (n === 2) return Promise.reject(new Error("attach two"));
    });
    holder.r = r;
    r.poll.start();
    try {
      await until(() => r.server.requests.some((q) => q.method === "getUpdates"));
      expect(r.logs).toEqual([
        connected,
        { kind: "telegram-attach-failed", error: "attach one" },
      ]);
      expect(waits).toEqual([1000, 2000]);
      expect(r.hook()).toBe(3);
      expect(r.server.requests.slice(0, 2).map((q) => q.method)).toEqual(["getMe", "getUpdates"]);
      expect(r.server.requests.filter((q) => q.method === "getMe")).toHaveLength(1);
      expect(seen).toEqual([1, 1, 1]);
    } finally {
      await r.poll.stop();
      await r.server.close();
    }
  });
  it("spec 090 AC-2: a stop while the hook is failing ends the loop", async () => {
    const waits: number[] = [];
    let release: () => void = () => {};
    let blocked = false;
    const r = await rig(
      async () => {
        if (waits.length >= 3) {
          blocked = true;
          await new Promise<void>((res) => (release = res));
        }
      },
      waits,
      async () => {
        throw new Error("always");
      },
    );
    r.poll.start();
    try {
      await until(() => blocked);
      const calls = r.hook();
      const stopped = r.poll.stop();
      release();
      await stopped;
      expect(r.hook()).toBe(calls);
      expect(calls).toBe(3);
      expect(r.logs.filter((l) => l.kind === "telegram-attach-failed")).toHaveLength(1);
      expect(r.server.requests.some((q) => q.method === "getUpdates")).toBe(false);
    } finally {
      await r.server.close();
    }
  });
});

describe("Telegram credentials from the store (spec 072 AC-1)", () => {
  const fakeCreds = join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-systemd-creds");
  afterEach(() => { delete process.env.FAKE_SYSTEMD_CREDS_FAIL; });
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "tg-store-"));
    const path = join(dir, "telegram.json");
    const cfg = { ...loadConfig(defaultConfigPath), telegram: { credentials_path: path, long_poll_timeout_s: 50 } };
    const store = new CredentialStore({ dir: join(dir, "store"), systemdCreds: fakeCreds });
    const logs: Record<string, unknown>[] = [];
    return { path, cfg, store, logs, log: (r: Record<string, unknown>) => logs.push(r) };
  }
  it("reads the stored secret with the file absent", async () => {
    const t = await setup();
    await t.store.writeSecret("telegram-bot", JSON.stringify({ bot_token: "STORED-TOKEN", chat_id: 7 }), "maintainer");
    const started = await startTelegram(t.cfg, t.log, undefined, t.store);
    expect(started?.source).toBe("store");
  });
  it("is off with the reason, and no token in the log, when the blob will not decrypt or has the wrong shape", async () => {
    const t = await setup();
    await writeFile(t.path, JSON.stringify({ bot_token: "FILE-TOKEN", chat_id: 1 }));
    await t.store.writeSecret("telegram-bot", JSON.stringify({ bot_token: "STORED-TOKEN", chat_id: 7 }), "maintainer");
    process.env.FAKE_SYSTEMD_CREDS_FAIL = "1";
    expect(await startTelegram(t.cfg, t.log, undefined, t.store)).toBeNull();
    delete process.env.FAKE_SYSTEMD_CREDS_FAIL;
    await t.store.writeSecret("telegram-bot", '{"bot_token":"STORED-TOKEN","chat_id":"x"}', "maintainer");
    expect(await startTelegram(t.cfg, t.log, undefined, t.store)).toBeNull();
    expect(t.logs.map((l) => l.reason)).toEqual(["stored telegram-bot credential unreadable", "stored telegram-bot credential has an invalid shape"]);
    expect(JSON.stringify(t.logs)).not.toContain("TOKEN");
  });
  it("reads the file while the index has no entry", async () => {
    const t = await setup();
    await writeFile(t.path, JSON.stringify({ bot_token: "FILE-TOKEN", chat_id: 1 }));
    expect((await startTelegram(t.cfg, t.log, undefined, t.store))?.source).toBe("file");
  });
});

describe("alert replies (spec 099 AC-7)", () => {
  it("a reply to a notifier message is matched to no question, even with one open question", () => {
    const r = { issue: 7, phase: "paused", nonce: "n", telegram: { message_id: 10, thread_message_ids: [10] }, question: { options: [] } } as unknown as PausedRecord;
    const update = { update_id: 1, message: { message_id: 11, date: 1, chat: { id: 1 }, text: "ok", reply_to_message: { message_id: 55 } } };
    expect(matchUpdate(update as never, [r], null, [55]).kind).toBe("alert-reply");
    expect(matchUpdate(update as never, [r], null, []).kind).toBe("ignore");
  });
});
