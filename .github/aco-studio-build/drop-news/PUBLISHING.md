# Drop News publishing contract

This is a public news feed. Never include customer/account data, credentials, private identifiers, private observations or internal logs. The installed app downloads only `public/aco-drop-news.json` from this repository's main branch. The news feature does not read customer vaults or change SKU selections, quantities, profiles or service settings.

The existing ChatGPT Monday briefing publishes the feed via the authorized GitHub connector. Fetch the current file on main, then update that exact path with its current blob SHA. Preserve schema 1 and all five retailer sections. Use a single atomic contents update; on conflict fetch the latest file before retrying. Do not modify code or any other files. Publication should not claim success unless the write and a subsequent fetch confirm it.

JSON fields:

- `schema`: 1
- `publishedAt`: current ISO timestamp in UTC, only after research is complete
- `summary`: short public briefing overview, including material source limitations
- `retailers`: exactly five objects with `id` of `target`, `walmart`, `pokemoncenter`, `costco`, `sams`; each has `coverage` (what was checked and gaps), `confirmed` (array), `checks` (array of verification recommendations).
- `rumors`: separate array of entries with an additional `retailer` field using one of the above IDs.

Each confirmed entry has `title`, `kind` (`drop`, `rule_change`, `policy_baseline`, or `listing`), `productName`, `sku`, `dropAt`, `details`, `planningImpact`, `checks` (array), and `sources` (array of `{title,url,checkedAt}`). `checkedAt` is an ISO timestamp for actual research. Use empty strings for unknown product identifiers or dates; explain uncertainty in details. The renderer labels `listing` as not confirming a drop time. `policy_baseline` is existing guidance and must never be framed as newly changed without dated evidence. Every confirmed claim requires a relevant checked official retailer source; the validator accepts the retailer's exact domain/subdomains, plus pokemon.com for Pokémon Center. An official domain alone does not prove that its content supports a claim: read the relevant page. Regional and marketplace listings do not confirm US first-party stock.

Rumor entries use the same fields plus `retailer`, with `kind` set to `rumor`. Sources may be reputable secondary reports, but every rumor needs a specific verification check. Do not invent rumors when there are no useful current reports.

Research confirmed upcoming US TCG drops and changes within the past week. Include product names and retailer identifiers (Target TCIN, Walmart item ID, Pokémon Center SKU, Costco item number, Sam's Club item number) when available; name identifier types. Distinguish launch dates, listing availability and confirmed retailer drop dates/times. Specify timezones. Verify purchase caps by order/account/person/household/membership, checkout/cart/queue rules, preorder conditions, membership/Plus requirements and shipping versus warehouse/club availability. Explain implications for SLABSNGRABSACO's retailer-specific SKU selection and drop planning within the published rules. Never recommend bypassing restrictions. Compare the prior edition before describing a change. Recheck dated baseline claims; do not silently carry old claims forward as current.

If sources cannot be checked, say so in coverage. Do not announce an absence of drops or changes based solely on a failed lookup. Retain the prior good edition on publishing/validation failure. The app labels stale editions and keeps a validated local cache for offline use. No news provider API key or additional background service is required.

Developer checks: reconstruct the existing desktop source using the active release workflow, apply this overlay after profile-library, run `npm run check`, and check actual navigation in the renderer. Both release pipelines run a native installed-app navigation smoke check before advancing their existing updater feeds.
