# SLABSNGRABSACO retailer intel — owner-authorized intake

## Status and source restrictions

This extension accepts **structured retailer facts supplied inside SLABSNGRABSACO's own private Admin channel**. It does not access or monitor Poke Signals or any other external Discord server, use a user session token, or bypass Discord bot permissions. An external automated source would require its own explicitly authorized integration; do not connect a self-bot.

A message in the existing private #admin channel must be authored by the verified guild owner and begin with `!intel ` followed by one compact JSON object or an array of up to 12 objects (1,800-character message limit). Other accounts, other channels, or other servers cannot invoke it. Requires the bot's existing Message Content intent.

All outputs are created as original SLABSNGRABSACO text/embeds with no copied external Discord message bodies, no @everyone ping, no cross-server posting.

## Owner intake examples

**Product alert** (sends to matching Target/Walmart/PKC/Costco/Sam's retailer channel; blue title; reports identifiers, price, stock and cart limit):

```text
!intel {"type":"product","retailer":"target","name":"30th Celebration Greninja ex Box","tcin":"1010892065","price":"$29.99","stock":"2k+","cartLimit":"2","date":"2026-10-24"}
```

**Potential drop heading** (send before product records; subsequent same date/time is deduplicated):

```text
!intel {"type":"drop","retailer":"target","date":"2026-10-24","dropTime":"03:00 ET","confirmed":false}
```

**Unconfirmed in-store availability** (one per retailer per date):

```text
!intel {"type":"in_store","retailer":"costco","date":"2026-10-24"}
```

**PKC queue**: an important-restocks potential queue goes to announcements and PKC. PKC channel detections only post to PKC. The queue-up and queue-down events post once to PKC on that date, no matter how many duplicate notices are provided.

```text
!intel {"type":"queue","retailer":"pkc","stage":"upcoming","date":"2026-10-24","source":"important-restocks"}
!intel {"type":"queue","retailer":"pkc","stage":"up","date":"2026-10-24","source":"pokemon-center"}
!intel {"type":"queue","retailer":"pkc","stage":"down","date":"2026-10-24","source":"pokemon-center"}
```

## Publication, updates, and retention

- Product identity is retailer + SKU/TCIN/PID/item number with matching identifier aliases, or compatible product name when there is no conflicting identifier. Do not guess a missing identifier.
- New messages are created once. Only a change in reported price, stock, or cart limit edits the original message. Missing incoming fields retain previously reported values.
- Product titles are blue Discord embed titles and body values use native embed fields. No source embeds are forwarded.
- No unverified online price is guessed. Add a verified price when available; an official-price lookup connector is a separate future integration.
- Older messages are **not removed on new drops**. The own-server retailer drop channels use age-based 14-day cleanup for non-pinned standard posts. Announcements are not broadly purged; only original, ledger-tracked retailer-intel messages expire.
- Ledger-tracked messages expire 14 days after their first creation even if edited later.
- Existing private SKU selection controls are not used for source collection. Expired source-message menus/drafts are cleaned up only after the corresponding post expires.
- Human/private chat, account, support-ticket, checkout-hits, and other unrelated channels are never included in drop retention.

## Release

Draft implementation in Pull Request #218. Verify regressions, channel permissions, persistent storage, and a staging bot before any production merge or deployment.
