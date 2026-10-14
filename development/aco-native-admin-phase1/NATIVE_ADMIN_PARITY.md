# ACO Studio — native Admin migration checklist

**Development branch only. Do not deploy until the full Admin parity checklist passes on Windows.**

The customer-facing website and existing Admin web page stay unchanged. ACO Studio
uses the existing authenticated website API and live change events, not a separate
customer or payment database. The native screen is locally rendered by Electron.
A separate website window is used solely to obtain an existing authorized Admin
session. The unchanged original website Admin remains available under
**Full Website Admin** for any function not yet native.

## Implemented and verified in the development build

| Capability | Native Admin today | Source |
| --- | --- | --- |
| Local Electron-rendered Admin workspace | Yes | `index.html` / `site-ui.js` |
| Admin sign-in in separate sandboxed website window | Yes | `site-bridge.js` |
| Customer directory and search | Yes (site data) | `site:read('roster')` |
| Customer summary / membership slots / linked-account counts | Yes | `site-model.js`, `site-ui.js` |
| Saved shipping and billing information | Read only | `site:read('customer')` |
| Saved website payment information | Masked references only | `site-model.js` |
| Linked retailer accounts / available pool / assignment and return | Existing native controls | `site-ui.js`, `site-bridge.js` |
| Desktop Jigging handoff | Existing, same authenticated customer identity | `profile-site-import.js` |
| Website-to-desktop live notification of changes | Existing authorized SSE, sync refresh | `site-bridge.js`, `site-ui.js` |
| Website Admin fallback with all original controls | Kept | `adminPage` WebContentsView |
| Separate local card and ZIP+4 encrypted stores | Kept unchanged | `local-card-vault.js`, `aco-private-bank.js` |

## Required before replacing the website fallback

| Area | Migration and verification needed |
| --- | --- |
| Shipping & billing | Add/edit/remove saved shipping and billing addresses through the same authenticated website endpoints and update the desktop when website or customers change them. Preserve validation. |
| Payment methods | Match existing tokenized/vault-backed add/edit/remove operations without exposing PAN or CVV through the desktop API or local logs. Verify safe user-specific authorization and security boundaries. |
| Customer accounts | Fully match activation flags, membership status, tiers, expiration bars, discounts and gifts, and reset-password/OG controls. |
| Memberships | Pricing, Stripe-linked billing reports, coupons, billing exceptions, paid/gifted/rented handling and member searches. |
| Orders & checkouts | Use existing order and verified-spend sources of truth with grouping, time filters, shipping status, notifications and correct user attribution. |
| Drops & SKUs | Same live SKU selections, quantity controls, schedule, buttons and Discord integration as website Admin. |
| Available retailer pool | Search, edit, delete, assign, return, jig/rejig, export and all original trackers and tags. |
| Home & operations | Notification tray and history, broadcasts, success mailbox, Discord settings, consent logs, and other Admin-only tools. |
| Desktop-to-website Jigging | Explicitly save approved jig changes back through transactional backend routes; local CSV/JSON export alone must never be treated as a website save. |
| Release validation | API contract tests, authorization tests, desktop UI tests, multi-session live-update tests, browser/Windows verification, accessibility and regression checks. |

### No control removals

The existing native customer directory, website customer import, profile jigging,
legacy account pool tools and full website Admin overlap in places. These are
**not removed** in this branch. Review and approve consolidation only after each
function has an equivalent native workflow and is verified end-to-end.

### Security guarantees

* Never bypass server-side authorization or use a web session as a long-lived
  replacement for Admin permissions.
* Website payment vault stays the single source of truth for customer payment
  records. No website card CVVs should be extracted or persisted locally.
* Existing encrypted local cards are a separate offline owner workspace; do not
  implicitly merge them with website-managed saved payment methods.
* The developer branch does not deploy to Render automatically; production
  continues running v4.11.0 until an explicitly verified release is approved.
