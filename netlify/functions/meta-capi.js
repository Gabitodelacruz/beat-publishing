/**
 * Meta Conversions API — server-side Purchase event  (Beat Publishing DTC)
 * S2 instrumentation. Pairs with api/stripe-webhook.js.
 *
 * WHY SERVER-SIDE:
 *   Checkout is Stripe-hosted (not our domain), so the browser pixel cannot reliably
 *   observe the completed purchase. Purchase is therefore fired here, from the
 *   `checkout.session.completed` handler, on confirmed payment — DECOUPLED from
 *   fulfilment so measurement stays correct even while the ISBN gate blocks Lulu/3PL.
 *
 * DEDUP:
 *   The storefront stamps a Meta `event_id` (plus fbp/fbc) into the Stripe Checkout
 *   Session metadata when it creates the session. The browser-side InitiateCheckout
 *   uses the SAME event_id, so Meta de-duplicates browser + server events.
 *
 * CONSENT (EU/UK/DE — blocking, see spec):
 *   Match keys derived from cookies (fbp/fbc) are sent ONLY when marketing consent
 *   was granted (stamped as metadata.consent_ads = "granted" at session creation).
 *   Without consent we send the minimum and rely on Stripe's own conversion reporting.
 *   This module does not constitute legal sign-off — see S2 spec, consent section.
 */

const crypto = require("crypto");

const GRAPH_VERSION = "v21.0"; // pin to the current Graph API version; bump deliberately
const PIXEL_ID = process.env.META_PIXEL_ID;
const CAPI_TOKEN = process.env.META_CAPI_TOKEN;
const TEST_CODE = process.env.META_TEST_EVENT_CODE || null; // set during verification only

const sha256 = (v) =>
  crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");

/**
 * Fire a Purchase event to the Meta Conversions API.
 * Never throws into the caller — measurement must not break fulfilment.
 *
 * @param {object} session  Stripe checkout.session.completed object
 * @param {object} meta     session.metadata (event_id, fbp, fbc, consent_ads, edition)
 */
async function sendPurchase(session, meta = {}) {
  if (!PIXEL_ID || !CAPI_TOKEN) {
    console.warn("[CAPI] skipped — META_PIXEL_ID / META_CAPI_TOKEN not set");
    return { sent: false, reason: "unconfigured" };
  }

  try {
    const consented = meta.consent_ads === "granted";

    const user_data = {
      em: [sha256(session.customer_details?.email || "")],
    };
    // Cookie-derived identifiers only with marketing consent.
    if (consented) {
      if (meta.fbp) user_data.fbp = meta.fbp;
      if (meta.fbc) user_data.fbc = meta.fbc;
      if (meta.client_ip) user_data.client_ip_address = meta.client_ip;
      if (meta.client_ua) user_data.client_user_agent = meta.client_ua;
    }

    const contents = meta.edition
      ? [{ id: meta.edition, quantity: 1 }] // matches ViewContent content_ids (edition key)
      : undefined;

    const payload = {
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor((session.created || Date.now() / 1000)),
          event_id: meta.event_id || session.id, // dedup key vs browser event
          action_source: "website",
          event_source_url: meta.source_url || "https://beatpublishing.com/",
          user_data,
          custom_data: {
            currency: (session.currency || "eur").toUpperCase(),
            value: (session.amount_total || 0) / 100,
            ...(contents ? { contents, content_type: "product" } : {}),
          },
        },
      ],
      ...(TEST_CODE ? { test_event_code: TEST_CODE } : {}),
    };

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const body = await r.text();
      console.error("[CAPI] Purchase rejected", r.status, body);
      return { sent: false, status: r.status };
    }
    return { sent: true, event_id: payload.data[0].event_id };
  } catch (err) {
    console.error("[CAPI] Purchase error (non-fatal)", err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendPurchase, sha256 };
