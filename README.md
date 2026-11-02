# Pulse Tickets — Paystack ticketing website

A beginner-friendly Node.js ticketing starter with:
- Public event listing and checkout; customers do **not** need accounts.
- Paystack-hosted payment checkout and server-side transaction verification.
- Unique QR ticket for each paid ticket, delivered by email.
- Staff QR camera scanner and manual ticket validation.
- One-time check-in: reused tickets are rejected.
- SQLite persistence.

## Requirements
- Node.js 20+ (recommended) and npm
- Paystack account (start with TEST keys)
- SMTP account for sending email (Gmail users should use an app password)
- HTTPS hosting for production; camera scanning usually requires HTTPS (localhost works for testing)

## Run on Windows / VS Code
1. Extract this project and open its folder in VS Code.
2. In the VS Code terminal run `npm install`.
3. Copy `.env.example` to `.env`.
   - PowerShell: `Copy-Item .env.example .env`
4. Edit `.env` and set `PAYSTACK_SECRET_KEY` to your Paystack **test secret key**.
5. Configure SMTP values and set a long random `SCANNER_KEY` (at least 24 characters).
6. Set `BASE_URL=http://localhost:3000` for local testing.
7. Start it with `npm start`.
8. Open `http://localhost:3000`.

## Test payment and email
1. Use Paystack test keys and Paystack's official test payment details from its dashboard/docs.
2. Complete a test checkout.
3. Paystack redirects to `/payment/return`; the server independently verifies the transaction before issuing tickets.
4. Configure Paystack webhook URL to `https://YOUR-DOMAIN/webhooks/paystack` on your deployed site. Webhooks are important for reliable fulfillment even if the buyer closes the browser.
5. Confirm email delivery and check spam. If SMTP is missing, the app logs that email was skipped.

## Scanner
- Open `http://localhost:3000/scanner.html` on the staff device.
- Enter the exact `SCANNER_KEY` from `.env`.
- Allow camera access, then scan a QR code. Or paste the QR JSON/ticket ID and click validate.
- A ticket is marked used at first check-in. Duplicate scans are rejected.
- Do not publish the scanner key or put it in frontend source code.

## Edit events
The starter seeds one demo event on first launch. The event is stored in `tickets.db`. For a quick demo, stop the server, delete `tickets.db`, change the seed event in `server.js`, and restart. Do not delete the database once you have real orders.

`price` is stored in the currency's smallest unit (for KES, 150000 means KSh 1,500.00). Set `CURRENCY` to a currency supported by your Paystack account. Confirm the amount/currency configuration in your Paystack dashboard before going live.

## Important production checklist
This is a starter, not a completed compliance review. Before selling real tickets:
- Deploy behind HTTPS, set a correct `BASE_URL`, use live Paystack keys only after end-to-end testing.
- Configure and test Paystack webhooks; monitor webhook failures and email failures.
- Use a private scanner key, rotate it when staff change, and restrict `/scanner.html` at the hosting/network layer if possible. “No login” here means no **customer** login; staff check-in still needs a secret.
- Add an organizer-only event management interface protected by authentication before allowing public event creation/editing.
- Add transactional email retries/outbox; current email failure is logged but not automatically retried.
- Add privacy policy, refund/cancellation policy, support contact, tax/receipt details, backups, database access controls, monitoring, and rate limits appropriate for launch.
- Consider capacity reservations/locking around concurrent checkouts and a reconciliation process for paid orders if the event sells out during simultaneous payments.
- Keep all secret keys in `.env` / deployment secrets. Never commit `.env` or expose `PAYSTACK_SECRET_KEY` to browser JavaScript.

## Routes
- `GET /api/events` — active events
- `POST /api/checkout` — create pending order and Paystack checkout URL
- `GET /payment/return` — server verifies payment before ticket issuance
- `POST /webhooks/paystack` — signature-verified webhook handler
- `GET /scanner.html` — staff scanner UI
- `/api/scanner/*` — protected by `x-scanner-key`

## Troubleshooting
- `Payments are not configured yet`: add your Paystack secret key to `.env` and restart.
- Ticket email not arriving: verify SMTP host/port/user/app password and `EMAIL_FROM`; check spam and terminal logs.
- Camera doesn't open: use localhost or HTTPS, allow camera permissions, and ensure no other app is using the camera.
- Paystack redirect doesn't work on a deployed app: set `BASE_URL` to the exact HTTPS domain and configure the webhook URL.

## Delete an event using SQL
run this to delete au event.
node
## Enter
const Database = require('better-sqlite3');
const db = new Database('./tickets.db');
## View your events:
console.table(db.prepare('SELECT id, title FROM events').all());
## Delete an event using its ID:
db.prepare('DELETE FROM events WHERE id = ?').run(1);
## Hide an event instead (recommended)
db.prepare('UPDATE events SET active = 0 WHERE id = ?').run(1);
