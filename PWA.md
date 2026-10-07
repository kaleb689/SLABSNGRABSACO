# Free Home Screen app

Slabs N Grabs ACO can be installed directly from its website. This uses the existing website hosting and accounts and requires no Apple Developer Program membership or app store listing.

## Install

- iPhone/iPad: open https://slabsngrabsaco.com in Safari, tap Share → Add to Home Screen, enable Open as Web App if shown, and tap Add.
- Android: open the site in Chrome, tap Install App on the site or use the browser menu's Install app / Add to Home screen option.
- Desktop: use Chrome/Edge's install option, or Safari's File → Add to Dock.

The site header's Install App button opens instructions or the supported browser's installation prompt. Instructions close with the X, Escape, or a click outside the dialog. Installed apps show Home, Pricing, Profile, Success and Guide navigation at the bottom.

## Behavior

- Uses the same accounts, payments, profiles, drop selections, success and live updates as the website; an internet connection is required.
- Changes arrive from the live website. There is no cached copy of the account dashboard or membership/payment data.
- The service worker caches only the generic offline reconnect page. API requests, mutations, event streams and external checkout requests are not intercepted. Navigation is network-only with a fallback on connection failure.
- Embedded Success previews do not register the worker, add an install button or show app navigation.
- Web push notifications are not configured by this change. Browser/device capabilities differ from a native app.
- This is not a TestFlight build. The earlier native app draft remains separate.

Verification: `node --test test/pwa.test.mjs test/pwa-worker.test.mjs`.

References:
- https://support.apple.com/guide/iphone/bookmark-a-website-iph42ab2f3a7/ios
- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
