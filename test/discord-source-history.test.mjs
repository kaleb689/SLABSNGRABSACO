import test from "node:test";
import assert from "node:assert/strict";
import { collectDiscordCheckoutPages } from "../discord-source-history.js";

const channel = "1532179373292257290";
const makeId = i => String(1580000000000000000n + BigInt(i));
const messages = Array.from({length: 240}, (_, i) => ({
  id: makeId(1000 + 240 - i),
  embeds: [{ title: "Successful Checkout!" }]
}));
function reader(source = messages) {
  return async before => source.filter(message => !before || BigInt(message.id) < BigInt(before)).slice(0, 100);
}

test("progressively imports older than the latest 1,000 with a persisted checkpoint", async () => {
  const first = await collectDiscordCheckoutPages(reader(), {
    channelId: channel, recentPages: 1, historyPages: 1
  });
  assert.equal(first.messages.length, 200);
  assert.equal(first.history.complete, false);
  assert.equal(first.history.historyPagesRead, 1);
  const second = await collectDiscordCheckoutPages(reader(), {
    channelId: channel, previous: first.history, recentPages: 1, historyPages: 1
  });
  assert.equal(second.history.complete, true);
  assert.equal(second.messages.length, 140);
  const unique = new Set([...first.messages, ...second.messages].map(message => message.id));
  assert.equal(unique.size, 240);
  const third = await collectDiscordCheckoutPages(reader(), {
    channelId: channel, previous: second.history, recentPages: 1, historyPages: 1
  });
  assert.equal(third.history.complete, true);
  assert.equal(third.history.historyPagesRead, 0);
});

test("small channels complete without a redundant historical scan", async () => {
  const result = await collectDiscordCheckoutPages(reader(messages.slice(0, 37)), {
    channelId: channel
  });
  assert.equal(result.messages.length, 37);
  assert.equal(result.history.complete, true);
  assert.equal(result.history.historyPagesRead, 0);
});

test("a checkpoint from a different channel cannot skip a newer source history", async () => {
  const first = await collectDiscordCheckoutPages(reader(), {
    channelId: channel, recentPages: 1, historyPages: 1
  });
  const other = await collectDiscordCheckoutPages(reader(), {
    channelId: "1551090141693485156",
    previous: {...first.history, complete: true},
    recentPages: 1, historyPages: 1
  });
  assert.equal(other.history.complete, false);
  assert.equal(other.messages.length, 200);
});

test("network failure aborts a historical batch before returning a checkpoint", async () => {
  let pages = 0;
  const failingReader = async before => {
    pages++;
    if (before) throw new Error("Discord unavailable");
    return messages.slice(0, 100);
  };
  await assert.rejects(collectDiscordCheckoutPages(failingReader, {
    channelId: channel, recentPages: 1, historyPages: 1
  }), /Discord unavailable/);
  assert.equal(pages, 2);
});

test("invalid source is rejected instead of importing the mirrored hits channel", async () => {
  await assert.rejects(collectDiscordCheckoutPages(reader(), {
    channelId: "not-a-channel"
  }), /numeric Discord checkout channel ID/);
});
