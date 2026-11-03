import test from "node:test";
import assert from "node:assert/strict";
import { dropImageSources, isDiscordImageUrl, MAX_DROP_IMAGES } from "../drop-images.js";

test("pictures come from the paste's link previews in product order, then attached photos", () => {
  const content = "Night\nLink: https://howl.link/aaa\n\nDay\nLink: https://howl.link/bbb";
  const message = { content,
    embeds: [
      { type: "article", url: "https://howl.link/bbb", thumbnail: { proxy_url: "https://media.discordapp.net/external/b.jpg" } },
      { type: "article", url: "https://howl.link/aaa", image: { proxy_url: "https://media.discordapp.net/external/a.jpg" } },
      { type: "rich", image: { url: "https://media.discordapp.net/external/ignored.jpg" } }
    ],
    attachments: [{ content_type: "image/png", proxy_url: "https://media.discordapp.net/attachments/1/2/box.png" },
      { content_type: "application/pdf", url: "https://cdn.discordapp.com/attachments/1/2/file.pdf" }] };
  assert.deepEqual(dropImageSources(message).map(x => x.url), [
    "https://media.discordapp.net/external/a.jpg",
    "https://media.discordapp.net/external/b.jpg",
    "https://media.discordapp.net/attachments/1/2/box.png"
  ]);
});

test("only Discord's own image hosts are downloaded, at most ten pictures", () => {
  assert.equal(isDiscordImageUrl("https://media.discordapp.net/x.png"), true);
  assert.equal(isDiscordImageUrl("https://evil.example/x.png"), false);
  assert.equal(isDiscordImageUrl("http://media.discordapp.net/x.png"), false);
  const many = { content: "", attachments: Array.from({ length: 14 }, (_, i) =>
    ({ content_type: "image/jpeg", url: "https://cdn.discordapp.com/attachments/1/" + i + ".jpg" })) };
  assert.equal(dropImageSources(many).length, MAX_DROP_IMAGES);
});
