require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const CURRENCY = process.env.CURRENCY || "KES";

const db = new Database("tickets.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  venue TEXT NOT NULL,
  event_date TEXT NOT NULL,
  price INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  sold INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL,
  buyer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  email_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  attendee_name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid',
  checked_in_at TEXT,
  FOREIGN KEY(order_id) REFERENCES orders(id),
  FOREIGN KEY(event_id) REFERENCES events(id)
);
`);

// Add each sample event independently.
// Existing events and ticket records are preserved.
const sampleEvents = [
  {
    title: "blackout",
    description:
      "Explore technology, innovation, artificial intelligence, and software development with tech enthusiasts.",
    venue: "Nairobi, Kenya",
    event_date: "2026-12-20T14:00",
    price: 200,
    capacity: 100
  },
];

const findEventByTitle = db.prepare(
  "SELECT id FROM events WHERE title = ?"
);

const insertEvent = db.prepare(`
  INSERT INTO events
    (title, description, venue, event_date, price, capacity)
  VALUES (?, ?, ?, ?, ?, ?)
`);

for (const event of sampleEvents) {
  if (!findEventByTitle.get(event.title)) {
    insertEvent.run(
      event.title,
      event.description,
      event.venue,
      event.event_date,
      event.price,
      event.capacity
    );

    console.log(`Added sample event: ${event.title}`);
  }
}

app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({
  limit: "100kb",
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith("/webhooks/paystack")) {
      req.rawBody = Buffer.from(buf);
    }
  }
}));

app.use(express.static(path.join(__dirname, "public")));

app.use("/api/", rateLimit({
  windowMs: 60_000,
  limit: 90,
  standardHeaders: true,
  legacyHeaders: false
}));

const mailReady = () =>
  Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );

function transporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function requireScannerKey(req, res, next) {
  const expected = process.env.SCANNER_KEY;

  if (!expected || expected.length < 24) {
    return res.status(503).json({
      error: "Scanner is not configured. Set a long SCANNER_KEY in .env."
    });
  }

  const supplied = req.get("x-scanner-key") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      error: "Scanner key is incorrect."
    });
  }

  next();
}

// Retrieve an event for checkout.
const getEvent = db.prepare(`
  SELECT id, title, description, venue, event_date, price, capacity, sold
  FROM events
  WHERE id = ? AND active = 1
`);

// Return ALL active events.
app.get("/api/events", (req, res) => {
  const events = db.prepare(`
    SELECT id, title, description, venue, event_date, price, capacity, sold
    FROM events
    WHERE active = 1
    ORDER BY event_date
  `).all();

  res.json(events);
});

app.get("/api/orders/:id", (req, res) => {
  const order = db.prepare(`
    SELECT
      o.id,
      o.status,
      o.quantity,
      o.amount,
      o.currency,
      o.email,
      e.title AS event_title,
      e.event_date,
      e.venue
    FROM orders o
    JOIN events e ON e.id = o.event_id
    WHERE o.id = ?
  `).get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  res.json(order);
});

app.post("/api/checkout", async (req, res) => {
  try {
    const { eventId, name, email, quantity } = req.body || {};
    const qty = Number(quantity);

    if (
      !Number.isInteger(Number(eventId)) ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > 10 ||
      typeof name !== "string" ||
      name.trim().length < 2 ||
      name.trim().length > 100 ||
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254
    ) {
      return res.status(400).json({
        error: "Enter a valid name, email, event, and quantity (1–10)."
      });
    }

    const event = getEvent.get(Number(eventId));

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (event.capacity - event.sold < qty) {
      return res.status(409).json({
        error: "Not enough tickets remain."
      });
    }

    if (
      !process.env.PAYSTACK_SECRET_KEY ||
      process.env.PAYSTACK_SECRET_KEY.includes("replace_me")
    ) {
      return res.status(503).json({
        error: "Payments are not configured yet. Add your Paystack secret key to .env."
      });
    }

    const orderId = crypto.randomUUID();
    const reference =
      `evt_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;

    const amount = event.price * qty;

    db.prepare(`
      INSERT INTO orders
        (id, event_id, buyer_name, email, quantity, amount, currency, reference, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      orderId,
      event.id,
      name.trim(),
      email.trim().toLowerCase(),
      qty,
      amount,
      CURRENCY,
      reference
    );

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          amount: String(amount),
          currency: CURRENCY,
          reference,
          callback_url:
            `${BASE_URL}/payment/return?order=${encodeURIComponent(orderId)}`,
          metadata: {
            order_id: orderId,
            event_id: event.id,
            quantity: qty,
            buyer_name: name.trim()
          }
        })
      }
    );

    const result = await response.json();

    if (
      !response.ok ||
      !result.status ||
      !result.data?.authorization_url
    ) {
      db.prepare(
        "UPDATE orders SET status = 'payment_error' WHERE id = ?"
      ).run(orderId);

      return res.status(502).json({
        error: result.message || "Could not initialize Paystack checkout."
      });
    }

    res.json({
      checkoutUrl: result.data.authorization_url,
      orderId
    });
  } catch (e) {
    console.error("Checkout error:", e.message);

    res.status(500).json({
      error: "Could not start checkout. Please try again."
    });
  }
});

async function verifyPaystack(reference) {
  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    }
  );

  const result = await response.json();

  if (
    !response.ok ||
    !result.status ||
    result.data?.status !== "success"
  ) {
    throw new Error("Payment is not verified as successful.");
  }

  return result.data;
}

async function fulfillOrder(reference, payData) {
  const order = db.prepare(
    "SELECT * FROM orders WHERE reference = ?"
  ).get(reference);

  if (!order) {
    throw new Error("Order not found for reference.");
  }

  if (order.status === "paid") {
    return order.id;
  }

  if (
    payData.currency !== order.currency ||
    Number(payData.amount) !== order.amount ||
    String(payData.customer?.email || "").toLowerCase() !==
      order.email.toLowerCase()
  ) {
    throw new Error(
      "Verified payment does not match the expected order."
    );
  }

  const event = db.prepare(
    "SELECT * FROM events WHERE id = ?"
  ).get(order.event_id);

  if (!event || event.capacity - event.sold < order.quantity) {
    throw new Error("Ticket capacity is no longer available.");
  }

  const makeTickets = db.transaction(() => {
    db.prepare(
      "UPDATE orders SET status = 'paid' WHERE id = ? AND status != 'paid'"
    ).run(order.id);

    db.prepare(
      "UPDATE events SET sold = sold + ? WHERE id = ?"
    ).run(order.quantity, order.event_id);

    const insert = db.prepare(`
      INSERT INTO tickets
        (id, order_id, event_id, attendee_name, email)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < order.quantity; i++) {
      insert.run(
        crypto.randomUUID(),
        order.id,
        order.event_id,
        order.buyer_name,
        order.email
      );
    }
  });

  makeTickets();
  return order.id;
}

async function sendTickets(orderId) {
  const order = db.prepare(`
    SELECT o.*, e.title, e.description, e.venue, e.event_date
    FROM orders o
    JOIN events e ON e.id = o.event_id
    WHERE o.id = ?
  `).get(orderId);

  if (!order || order.status !== "paid") return;

  if (!mailReady()) {
    console.warn(
      "SMTP not configured; ticket email skipped for order",
      orderId
    );
    return;
  }

  const tickets = db.prepare(
    "SELECT * FROM tickets WHERE order_id = ?"
  ).all(orderId);

  const attachments = [];
  const ticketBlocks = [];

  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];

    const qrData = JSON.stringify({
      ticketId: t.id,
      eventId: t.event_id
    });

    const dataUrl = await QRCode.toDataURL(
      qrData,
      { width: 300, margin: 2 }
    );

    const cid = `ticketqr${i}`;

    attachments.push({
      filename: `ticket-${i + 1}-qr.png`,
      content: Buffer.from(
        dataUrl.split(",")[1],
        "base64"
      ),
      cid
    });

    ticketBlocks.push(`
      <div style="border:1px solid #ddd;border-radius:12px;padding:18px;margin:16px 0">
        <h3>Ticket ${i + 1}</h3>
        <p><b>${escapeHtml(order.title)}</b></p>
        <p>${escapeHtml(order.venue)} · ${escapeHtml(order.event_date)}</p>
        <p>Attendee: ${escapeHtml(order.buyer_name)}</p>
        <img width="200" alt="Ticket QR code" src="cid:${cid}">
        <p style="font-size:12px;color:#555">
          Keep this QR code private. It can be scanned once at entry.
        </p>
      </div>
    `);
  }

  await transporter().sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: order.email,
    subject: `Your ticket${tickets.length > 1 ? "s" : ""} for ${order.title}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:650px;margin:auto">
        <h1>You're booked!</h1>
        <p>Payment confirmed. Keep this email and show each QR code at the entrance.</p>
        ${ticketBlocks.join("")}
        <p>Order reference: ${escapeHtml(order.reference)}</p>
      </div>
    `,
    attachments
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c])
  );
}

app.get("/payment/return", async (req, res) => {
  const orderId = String(req.query.order || "");

  const order = db.prepare(
    "SELECT * FROM orders WHERE id = ?"
  ).get(orderId);

  if (!order) {
    return res.redirect("/?payment=notfound");
  }

  try {
    const payData = await verifyPaystack(order.reference);

    await fulfillOrder(order.reference, payData);

    try {
      await sendTickets(order.id);
    } catch (e) {
      console.error("Ticket email failed:", e.message);
    }

    res.redirect(
      `/success.html?order=${encodeURIComponent(order.id)}`
    );
  } catch (e) {
    console.error("Payment verification:", e.message);

    res.redirect(
      `/success.html?order=${encodeURIComponent(order.id)}&pending=1`
    );
  }
});

// Paystack webhook
app.post("/api/paystack/webhook", async (req, res) => {
  res.sendStatus(200);
});

app.post("/webhooks/paystack", async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || "";
  const signature = req.get("x-paystack-signature") || "";
  const rawBody = req.rawBody || Buffer.from("");

  const expected = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (
    !secret ||
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.sendStatus(401);
  }

  try {
    const event = JSON.parse(rawBody.toString("utf8"));

    if (
      event.event === "charge.success" &&
      event.data?.reference
    ) {
      const verified = await verifyPaystack(event.data.reference);
      const orderId = await fulfillOrder(
        event.data.reference,
        verified
      );

      try {
        await sendTickets(orderId);
      } catch (e) {
        console.error("Webhook email failed:", e.message);
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook processing:", e.message);
    res.sendStatus(500);
  }
});

app.get(
  "/api/scanner/lookup/:ticketId",
  requireScannerKey,
  (req, res) => {
    const ticket = db.prepare(`
      SELECT
        t.id,
        t.status,
        t.checked_in_at,
        t.attendee_name,
        t.email,
        e.title,
        e.venue,
        e.event_date
      FROM tickets t
      JOIN events e ON e.id = t.event_id
      WHERE t.id = ?
    `).get(req.params.ticketId);

    if (!ticket) {
      return res.status(404).json({
        error: "Ticket not found"
      });
    }

    res.json(ticket);
  }
);

app.post(
  "/api/scanner/checkin",
  requireScannerKey,
  (req, res) => {
    const ticketId = String(req.body?.ticketId || "");

    if (!ticketId || ticketId.length > 80) {
      return res.status(400).json({
        error: "Invalid ticket ID"
      });
    }

    const ticket = db.prepare(
      "SELECT id, status FROM tickets WHERE id = ?"
    ).get(ticketId);

    if (!ticket) {
      return res.status(404).json({
        error: "Ticket not found. Do not admit."
      });
    }

    if (ticket.status === "used") {
      return res.status(409).json({
        error: "Already checked in. Do not admit."
      });
    }

    const result = db.prepare(`
      UPDATE tickets
      SET status = 'used', checked_in_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'valid'
    `).run(ticketId);

    if (!result.changes) {
      return res.status(409).json({
        error: "Ticket was already used. Do not admit."
      });
    }

    res.json({
      ok: true,
      message: "Valid ticket — checked in.",
      ticketId
    });
  }
);

app.get("/api/scanner/stats", requireScannerKey, (req, res) => {
  res.json({
    tickets: db.prepare(
      "SELECT COUNT(*) AS n FROM tickets"
    ).get().n,

    checkedIn: db.prepare(
      "SELECT COUNT(*) AS n FROM tickets WHERE status = 'used'"
    ).get().n,

    paidOrders: db.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'"
    ).get().n
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Ticketing site running at ${BASE_URL}`);
});