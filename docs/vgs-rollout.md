# ACO card vault rollout

## Status

The VGS Sandbox vault is for test data only. Dashboard inspection found zero vault records; organization activation is pending. A Sandbox inbound route named `ACO card tokenization - Sandbox` points to the Vault API v2 host, with no proxy filters. A service account named `aco-sbx-write` is limited to that Sandbox vault and the `aliases:write` scope. The vault ID, route ID, client ID, and client secret are saved as `VGS_SANDBOX_*` environment variables in the Render service with **Save only**; never place their values in this public repository. There is no Live vault ID or reveal route yet. **The deployed site does not use VGS.** The Home security stamp and per-card notices are deliberately dormant until the entire card flow is vaulted.

Stripe Checkout remains the membership payment processor. VGS is the separate vault for ACO cards, which the business needs to reveal for its ACO workflow. The `securityCode` field is a separate ACO account code, not the card's CVV/CVC; it stays in the existing account-secret storage and must never be supplied to VGS as a card-security-code field.

## Groundwork in this branch

- Home has a hidden VGS stamp at the bottom of its section.
- `public/card-security-notices.js` provides a dormant function to add a notice beside every card-number input, including forms rendered after page load. It is included on the customer and admin pages but is never invoked.
- The first ACO profile's account-security-code field no longer advertises itself as browser card CVV autofill; it is labeled explicitly and accepts a separate account code.
- None of these changes enable VGS or claim that current cards are vaulted.

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
