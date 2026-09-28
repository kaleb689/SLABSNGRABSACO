# ACO card vault rollout

## Status

The VGS Sandbox vault is for test data only. Dashboard inspection found zero vault records; organization activation is pending. A Sandbox inbound route named `ACO card tokenization - Sandbox` points to the Vault API v2 host, with no proxy filters. A service account named `aco-sbx-write` is limited to that Sandbox vault and the `aliases:write` scope. The vault ID, route ID, client ID, and client secret are saved as `VGS_SANDBOX_*` environment variables in the Render service with **Save only**; never place their values in this public repository. There is no Live vault ID or reveal route yet. **The deployed site does not use VGS.** The Home security stamp and per-card notices are deliberately dormant until the entire card flow is vaulted.

Stripe Checkout remains the membership payment processor. VGS is the separate vault for ACO cards, which the business needs to reveal for its ACO workflow. The `securityCode` field is a separate ACO account code, not the card's CVV/CVC; it stays in the existing account-secret storage and must never be supplied to VGS as a card-security-code field.

## Groundwork in this branch

- Home has a hidden VGS stamp at the bottom of its section.
- `public/card-security-notices.js` provides a dormant function to add a notice beside every card-number input, including forms rendered after page load. It is included on the customer and admin pages but is never invoked.
- The first ACO profile's account-security-code field no longer advertises itself as browser card CVV autofill; it is labeled explicitly and accepts a separate account code.
- None of these changes enable VGS or claim that current cards are vaulted.

## Multiple cards and reveal contract

The existing customer saved-card endpoints are `POST /api/account/payment-methods`, `PUT /api/account/payment-methods/:id`, and `DELETE /api/account/payment-methods/:id`; they currently allow up to **20 cards per customer**. Preserve that limit and each saved card's stable ID so linked orders, retailer profiles, and autofill selections keep working. On add or replacement, VGS Collect should create a distinct persistent PAN alias for that card. The account vault should keep only the alias, vault environment, last four, card brand, cardholder, expiration, label, and separate ACO account code. Updating a label or account code must not require re-entering the card; replacing a number must create a new alias and retire the old one under the retention policy.

For each card row, provide a **Reveal card** action. After customer ownership or admin authorization is checked against the saved card ID, render the full number and expiration in VGS Show's isolated field for a short on-demand session. Do not place raw PAN in HTML attributes, ordinary JavaScript variables, JSON responses, logs, exports, or a general-purpose read credential sent to the browser. Customer and admin reveal must both work for the initial ACO card and every extra card. The separate account security code remains readable through its existing authenticated view; card CVV is not retained or revealed later.

| Existing entry or reuse path | Cutover requirement |
| --- | --- |
| Initial ACO profile in `public/index.html` and its submit handler | Collect first card through hosted fields; save alias and masked metadata. |
| Customer saved-card form and the three `/api/account/payment-methods` endpoints | Add, edit, remove, and reveal any of the 20 cards; maintain ownership checks. |
| Order card replacement and linked saved-card selection in `public/app.js` | Use an alias for replacement; preserve the selected card ID for order reuse. |
| Admin saved-card edits, submission edits, and retailer/special profiles in `public/admin.html` | Accept aliases and metadata; reveal only after admin authorization; preserve linked card IDs. |
| Server projections, encrypted customer vaults, order secrets, and exports in `server.js` | Remove raw PAN from all new writes and responses; migrate historical values before the security stamp appears. |

The Sandbox `aco-sbx-write` account cannot read aliases. A separate reveal configuration with the minimum required permissions must be created and tested before enabling Show. Keep Sandbox and Live credentials separate; never point the deployed site at Sandbox for real customer cards.

## Required implementation before activation

1. In Sandbox, configure VGS Collect hosted fields for card number and expiration, plus an inbound route and narrowly scoped authentication. Use test card data only. The form must send the primary account number directly to VGS, never through this site's DOM, JavaScript value, API request body, logs, or email.
2. Store the VGS card alias, last four digits, cardholder, expiry, and vault environment with the account/order. Do not store a raw card number in `customer-*-vault.encrypted.json`, order secrets, account snapshots, or admin/customer API responses. Alias validation must be explicit; the existing numeric-card validators cannot validate aliases.
3. Migrate all card entry and update paths: initial ACO profile, extra saved cards, order card replacement, customer-managed account cards, and all admin card-edit forms. The relevant code spans `public/index.html`, `public/app.js`, `public/admin.html`, and `server.js`. Do not accept raw PAN on any legacy endpoint after cutover.
4. Provide authenticated, on-demand card reveal for the authorized customer and admin using VGS Show's isolated iframe. Enforce ownership on customer requests and admin authorization on admin requests. Add short reveal duration and audit events. The full number must not pass through the site's server or ordinary API responses. Keep the separate account code in its existing authenticated view.
5. Inventory and migrate existing encrypted PAN records with VGS and a PCI specialist, then verify removal of raw PAN copies from application data and backups under an approved retention process. Do not put existing real cards in Sandbox.
6. Activate the VGS organization, create a separate Live vault, promote and verify the tested routes and access rules, add secrets in Render environment settings, and run an end-to-end Live test with an authorized payment method.
7. Only once all paths use VGS, invoke `activateVgsCardNotices()` on the customer and admin pages. That makes the Home stamp and nearby card-entry notices visible. Verify the notice is accurate on every path before deploying it.

## Cutover gates

- No raw card numbers in site requests, responses, files, or logs; only provider aliases and masked metadata.
- An authenticated customer can see only their own full card on demand, and an authorized admin can reveal the needed card on demand. A reveal closes after a short period.
- The separate ACO account code still works and is never treated as CVV. No card CVV is collected, stored, or shown.
- A customer can add, replace, and remove cards in every account and order flow without breaking Stripe membership payments.
- VGS Live is active for real card data, and the badge is enabled only after the above checks pass.

Do not enable the VGS stamp based solely on possession of a Vault ID: a Vault ID does not prove the site is using VGS.
