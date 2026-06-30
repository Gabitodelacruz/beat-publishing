/**
 * Stripe -> fulfilment webhook  (Beat Publishing DTC) — Netlify Function build
 * Adapted from the Express version. Deploy path (via netlify.toml redirect):
 *   POST https://beatpublishing.com/api/webhooks/stripe
 *
 * Repo layout this assumes:
 *   /config/catalog.json
 *   /netlify/functions/stripe-webhook.js   (this file)
 *   /netlify/functions/meta-capi.js        (the S2 CAPI module)
 *
 * Notes:
 *  - Netlify passes the RAW request body as event.body (string). Stripe signature
 *    verification needs that raw body — do NOT JSON.parse before constructEvent.
 *  - The in-memory `processed` set only dedupes within a warm instance. For production
 *    idempotency use a durable store (Netlify Blobs / Upstash / a DB). Acceptable at
 *    launch volume because the Lulu call is the only non-idempotent side effect.
 */

const Stripe = require("stripe");
const catalog = require("../../config/catalog.json");
const { sendPurchase } = require("./meta-capi");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const ENDPOINT_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const processed = new Set();

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const sig = event.headers["stripe-signature"];
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  let evt;
  try {
    evt = stripe.webhooks.constructEvent(raw, sig, ENDPOINT_SECRET);
  } catch (err) {
    return { statusCode: 400, body: `Signature verification failed: ${err.message}` };
  }

  if (evt.type !== "checkout.session.completed") {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }
  if (processed.has(evt.id)) {
    return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
  }
  processed.add(evt.id);

  const session = evt.data.object;

  // S2: fire Purchase to Meta CAPI on confirmed payment, BEFORE fulfilment so
  // measurement is correct even if a fulfilment step throws. event_id rides in
  // client_reference_id (Payment Links can't carry per-click metadata).
  await sendPurchase(session, {
    ...(session.metadata || {}),
    event_id: session.client_reference_id || session.id,
  });

  try {
    const order = await buildOrder(session);
    const result = await routeFulfilment(order);
    await persist(session.id, order, result);
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, routed_to: result.provider, provider_order: result.id }),
    };
  } catch (err) {
    console.error("Fulfilment error", session.id, err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

/* ---- fulfilment logic (unchanged from the Express version) ---- */

async function buildOrder(session) {
  const items = await stripe.checkout.sessions.listLineItems(session.id, { expand: ["data.price.product"] });
  const li = items.data[0];
  const meta = (li.price.product.metadata) || {};
  const edition = meta.edition;
  if (!edition || !catalog.editions[edition]) throw new Error("Unknown edition on product metadata");

  const isbn = catalog.editions[edition].isbn;
  if (String(isbn).startsWith("PENDING")) throw new Error("ISBN unresolved");

  const addr = session.shipping_details?.address || session.customer_details?.address;
  const country = addr?.country || "DEFAULT";
  const market = catalog.markets[country] || catalog.markets.DEFAULT;

  return {
    edition, isbn,
    qty: li.quantity || 1,
    email: session.customer_details?.email,
    name: session.shipping_details?.name || session.customer_details?.name,
    address: addr,
    country,
    fulfil_region: market.fulfil_region,
  };
}

async function routeFulfilment(order) {
  if (order.fulfil_region === "EU" && (await offsetStockOnHand(order.edition)) > 0) {
    return createPickPack(order);
  }
  return createLuluOrder(order);
}

async function offsetStockOnHand() { return 0; }

async function createLuluOrder(order) {
  const body = {
    line_items: [{
      external_id: order.isbn,
      printable_normalization: { pod_package_id: process.env["LULU_POD_PACKAGE_" + order.edition.toUpperCase()] },
      quantity: order.qty,
    }],
    shipping_address: toLulu(order.address, order.name),
    shipping_level: "MAIL",
    contact_email: order.email,
  };
  const r = await fetch("https://api.lulu.com/print-jobs/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (await luluToken()) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Lulu print-job failed: " + r.status);
  const data = await r.json();
  return { provider: "lulu", id: data.id };
}

async function createPickPack(order) {
  const r = await fetch(process.env.EU_3PL_ORDER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + process.env.EU_3PL_KEY },
    body: JSON.stringify({ sku: "OFFSET_" + order.edition.toUpperCase(), qty: order.qty,
      ship_to: order.address, name: order.name, email: order.email }),
  });
  if (!r.ok) throw new Error("EU 3PL order failed: " + r.status);
  const data = await r.json();
  return { provider: "eu_3pl", id: data.order_id };
}

function toLulu(a, name) {
  return { name, street1: a.line1, street2: a.line2 || "", city: a.city,
    state_code: a.state || "", postcode: a.postal_code, country_code: a.country, phone_number: "" };
}

let _tok;
async function luluToken() {
  if (_tok && _tok.exp > Date.now()) return _tok.v;
  const r = await fetch("https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&client_id=" + process.env.LULU_CLIENT_ID +
          "&client_secret=" + process.env.LULU_CLIENT_SECRET,
  });
  const d = await r.json();
  _tok = { v: d.access_token, exp: Date.now() + (d.expires_in - 30) * 1000 };
  return _tok.v;
}

async function persist(sessionId, order, result) {
  console.log("FULFILLED", sessionId, "->", result.provider, result.id, order.country);
}
