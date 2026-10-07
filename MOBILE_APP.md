# Slabs N Grabs ACO mobile apps

The iOS and Android apps share the production Slabs N Grabs ACO account, API, Stripe, Success, shipping, drops, rental and Discord-linking systems.

## App identity
- App name: Slabs N Grabs ACO
- Bundle/application ID: com.slabsngrabs.aco
- Production origin: https://slabsngrabsaco.com

## Local setup
1. Install Node 22+ and run `npm install`.
2. Generate native projects once with `npm run mobile:add:ios` on macOS and `npm run mobile:add:android`.
3. Run `npm run mobile:sync` after Capacitor/plugin changes.
4. Open iOS with `npm run mobile:open:ios`; open Android with `npm run mobile:open:android`.

## Launch checklist
- Generate final app icon and splash assets from the approved Slabs N Grabs logo.
- Configure Apple signing/team and create the App Store Connect app.
- Configure Android signing and create the Google Play Console app.
- Configure APNs + Firebase Cloud Messaging credentials for native push.
- Verify Stripe checkout/return flow on physical iPhone and Android devices.
- Verify login/session persistence, profile editing, paid-profile forms, rentals, Discord linking, Success graph/orders, shipping tracker, Drop selections, password reset, external links and live updates.
- Add privacy policy/support URLs and complete Apple/Google privacy declarations.
- Produce TestFlight and Play Internal Testing builds before production submission.

Do not put Apple, Google, Stripe, Discord, APNs, Firebase or signing secrets in this repository.
