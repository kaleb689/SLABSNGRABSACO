# SLABSNGRABSACO Website

A modern membership website with:

- Home page
- Three pricing tiers
- Profile submission form based on the supplied reference
- Stripe Checkout subscriptions
- Stripe webhook confirmation
- Optional email delivery of paid profile submissions through Resend

## Important security design

The profile form intentionally does **not** collect full card numbers, expiration dates, or CVVs. Customers enter payment details directly on Stripe's hosted checkout page.

Do not put your Stripe secret key in browser code, HTML, or a public repository.

## Run locally

1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Run:

```bash
npm install
cp .env.example .env
npm start
```

4. Visit `http://localhost:4242`.

## Configure Stripe

1. In Stripe Dashboard, create three recurring monthly Prices:
   - Tier 1: $30/month
   - Tier 2: $50/month
   - Tier 3: $80/month
2. Copy each `price_...` ID into `.env`.
3. Add your Stripe secret key to `STRIPE_SECRET_KEY`.
4. For local webhook testing, install the Stripe CLI and run:

```bash
stripe listen --forward-to localhost:4242/api/stripe-webhook
```

5. Copy the displayed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.

For production, create a webhook endpoint at:

`https://YOUR-DOMAIN.com/api/stripe-webhook`

Subscribe to the `checkout.session.completed` event.

## Email the paid profile submission to yourself

The app supports Resend:

1. Create a Resend account and verify a sending domain.
2. Add these values to `.env`:

```env
RESEND_API_KEY=re_replace_me
BUSINESS_EMAIL=you@example.com
FROM_EMAIL=SLABSNGRABSACO <no-reply@your-verified-domain.com>
```

The profile submission is emailed only after Stripe sends a verified `checkout.session.completed` webhook.

If Resend is not configured, paid submissions are retained in `data/paid-submissions.json` for development purposes. Use a real database and secure access controls before production.

## Deploy

Deploy the Node app to a host that supports a persistent server, environment variables, HTTPS, and webhook endpoints, such as Render, Railway, Fly.io, or a VPS. Set `BASE_URL` to the public HTTPS URL.

Before launch, add your terms of service, privacy policy, refund/cancellation policy, and confirm that your service complies with applicable retailer terms and laws.


## Secure ACO setup package

The profile form now also accepts a dedicated ACO/IMAP email + password and the payment-card details needed for the customer's requested ACO profile. These values are **not** placed in notification email.

They are encrypted at rest using AES-256-GCM. Set a long, random `SUBMISSION_ENCRYPTION_KEY` in your production environment. Keep this key outside the repository and restrict server access.

Important production requirements:
- HTTPS only.
- Never log request bodies containing credentials/card data.
- Restrict access to encrypted packages to authorized administrators.
- Use a managed secrets vault / database rather than local disk for a real deployment.
- Establish a short retention period and delete sensitive setup data after configuration.
- Stripe remains responsible only for the membership/subscription payment; the ACO setup card is separate.
- Before accepting live card data, verify your PCI DSS responsibilities with your payment/security provider. Encrypting card data does not by itself make a system PCI compliant.


## Admin dashboard

Open the **Admin** page and sign in using `ADMIN_PASSWORD`. The server issues an HttpOnly, SameSite=Strict session cookie that expires after 30 minutes. Login attempts are rate limited. Paid submissions can be decrypted for authorized viewing and their sensitive package can be permanently deleted.

For production, put the admin dashboard behind HTTPS and preferably MFA/SSO or a zero-trust access layer. The included password login is a starter implementation, not a substitute for a professionally managed identity system.

## PCI correction: CVV

The website no longer collects or stores CVV for the ACO setup card. PCI DSS prohibits retaining CVV after authorization and specifically prohibits retaining it for concierge-style future transactions, even if encrypted or the customer consents. The site may still store PAN/expiration data, which keeps the environment in PCI DSS scope and can substantially increase compliance obligations. Confirm the correct validation path with your acquiring bank and a PCI Qualified Security Assessor before production use.


## CVV confirmation

The ACO profile form records only a boolean `cvvConfirmed` value indicating that the customer confirmed they possess/access the card CVV. The CVV digits are never requested, transmitted, logged, encrypted, stored, emailed, or displayed in the admin dashboard.


## Private admin portal
The public site does not link to the admin portal. After deployment, access it directly at `/admin`. Set a unique strong `ADMIN_PASSWORD` in the host environment. Production should use HTTPS and MFA/identity-aware access in front of `/admin`; never commit the password to source control.
