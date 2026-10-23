// Supporter billing: the supporter tier's rules and every Stripe-driven change to a login's supporter state.
// It takes the Stripe client to use, shaped like the Stripe SDK: the real one in production, an in-memory one in tests
// (test/fake-stripe.js). Routes keep sign-in, the form token, whether the tier is on, and the pages and status codes.
const { db } = require('./db');
const { keyedQueue } = require('./util');

const GRACE = 3 * 86400000; // Stripe retries a failed renewal for a few days before giving up
const LIVE = ['active', 'trialing', 'past_due', 'incomplete']; // a second subscription is refused while one of these exists
const ENDED = ['canceled', 'incomplete_expired']; // nothing left to cancel
class BadSignature extends Error {}

// cfg for the prices and base URL; logins (src/logins.js) so an extra site pays for its login
function createBilling({ cfg, logins, stripe, webhookSecret }) {
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');

  // a subscription's state sets supporter_until: paid up to the period's end (plus a few days for a late renewal), or over now
  async function apply(sub) {
    const login = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(String(sub.customer)) ||
      db.prepare('SELECT * FROM users WHERE id = ? AND login_id IS NULL').get(Number(sub.metadata?.user_id) || 0);
    if (!login) return;
    // newer Stripe API versions keep the period on each item
    const item = sub.items?.data?.[0];
    const start = (item?.current_period_start ?? sub.current_period_start ?? 0) * 1000;
    const end = (item?.current_period_end ?? sub.current_period_end ?? 0) * 1000;
    let until = null;
    if (['active', 'trialing'].includes(sub.status) && end) until = end + GRACE;
    // a failed renewal already moved the period on, but only the one before it was paid: perks run the grace days past it
    else if (sub.status === 'past_due' && start) until = start + GRACE;
    else if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
      // a late event about an old subscription must not end perks a newer one is paying for
      for await (const other of stripe.subscriptions.list({ customer: String(sub.customer), status: 'all' })) {
        if (other.id !== sub.id && ['active', 'trialing', 'past_due'].includes(other.status)) return;
      }
      until = Math.min(login.supporter_until, Date.now());
    }
    db.prepare('UPDATE users SET stripe_customer_id = ?, supporter_until = COALESCE(?, supporter_until) WHERE id = ?').run(String(sub.customer), until, login.id);
  }

  // { url } to send the member to Stripe Checkout, or { already: true } while they support or a subscription is live.
  // Throws when Stripe can't be reached. One login's checkouts run one at a time, so two at once can't both find no open
  // checkout and each make one: the second waits, then reuses what the first made.
  // shortcut: the queue is per process, which covers the single app container; use Stripe idempotency keys if the app ever runs as several
  const queues = keyedQueue(); // by login id; a failed checkout still lets the next one go
  function checkout(site, plan) {
    const id = logins.loginOf(site).id;
    return queues.run(id, () => checkoutNow(id, plan));
  }
  async function checkoutNow(id, plan) {
    let login = byId.get(id); // as the checkout before it left it
    if (login.supporter_until > Date.now() && login.stripe_customer_id) return { already: true };
    // one Stripe customer per login, made before checkout, so a second tab or a payment the webhook hasn't reported yet
    // finds the same customer: an open checkout is reused and a live subscription refuses another
    if (!login.stripe_customer_id) {
      const customer = await stripe.customers.create({ email: login.email, metadata: { user_id: String(login.id) } });
      // two requests at once: the first stored wins, the other customer is left unused
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id = ''").run(customer.id, login.id);
      login = byId.get(login.id);
    }
    for await (const sub of stripe.subscriptions.list({ customer: login.stripe_customer_id, status: 'all', limit: 100 })) {
      if (LIVE.includes(sub.status)) return { already: true };
    }
    // the support page offers monthly, plus yearly while a yearly price is set; a choice that is not on offer takes the default price
    const price = plan === 'annual' ? (cfg.PRICE_ID_ANNUAL || cfg.PRICE_ID) : (cfg.PRICE_ID || cfg.PRICE_ID_ANNUAL);
    const openIds = [];
    for await (const open of stripe.checkout.sessions.list({ customer: login.stripe_customer_id, status: 'open', limit: 100, expand: ['data.line_items'] })) {
      if (open.line_items?.data[0]?.price?.id === price) return { url: open.url };
      openIds.push(open.id);
    }
    // only after every page has no matching checkout, drop the other plans so the member can switch
    for (const id of openIds) await stripe.checkout.sessions.expire(id);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      client_reference_id: String(login.id),
      // flexible billing mode: Stripe's recommended default for predictable proration and invoices
      subscription_data: { metadata: { user_id: String(login.id) }, billing_mode: { type: 'flexible' } },
      customer: login.stripe_customer_id,
      success_url: `${cfg.BASE_URL}/dashboard/support?ok=${encodeURIComponent('Thank you! Your supporter perks switch on as soon as Stripe confirms the payment.')}`,
      cancel_url: `${cfg.BASE_URL}/dashboard/support`,
    });
    return { url: session.url };
  }

  // Stripe's Customer Portal (cancel, change the card, see receipts), or null for a login Stripe doesn't know yet
  async function portal(site) {
    const login = logins.loginOf(site);
    if (!login.stripe_customer_id) return null;
    return (await stripe.billingPortal.sessions.create({ customer: login.stripe_customer_id, return_url: `${cfg.BASE_URL}/dashboard/support` })).url;
  }

  // A webhook call: throws BadSignature unless Stripe signed this raw body; any other throw means Stripe should retry.
  // Events arrive in two shapes: a classic endpoint embeds the object in the event, while an event destination sends
  // a thin event — no object inside, just its type (prefixed v1.) and a pointer at the object — which constructEvent
  // refuses and the SDK verifies as an event notification instead. Either way the object is fetched by id below.
  async function receive(rawBody, signature) {
    let event;
    try { event = stripe.webhooks.constructEvent(rawBody, signature || '', webhookSecret); }
    catch {
      let note;
      try { note = stripe.parseEventNotification(rawBody, signature || '', webhookSecret); } catch { throw new BadSignature('bad signature'); }
      event = { thin: true, type: note.type.replace(/^v1\./, ''), id: note.related_object?.id };
    }
    if (event.type === 'checkout.session.completed') {
      const o = event.thin ? (event.id ? await stripe.checkout.sessions.retrieve(event.id) : null) : event.data.object;
      if (o?.customer) {
        db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND login_id IS NULL').run(String(o.customer), Number(o.client_reference_id) || 0);
      }
    } else if (event.type.startsWith('customer.subscription.')) {
      const id = event.thin ? event.id : event.data.object.id;
      // the payload may be stale (Stripe can deliver or retry events out of order), so apply the subscription as it is now
      if (id) await apply(await stripe.subscriptions.retrieve(id));
    }
  }

  // a deleted login must stop paying: true once nothing bills it or can start to, false (never a throw) when Stripe can't be reached
  async function cancel(site) {
    if (!logins.isLogin(site) || !site.stripe_customer_id) return true;
    try {
      // an open checkout left in another tab could still be paid after the login is gone
      for await (const open of stripe.checkout.sessions.list({ customer: site.stripe_customer_id, status: 'open', limit: 100 })) await stripe.checkout.sessions.expire(open.id);
      for await (const sub of stripe.subscriptions.list({ customer: site.stripe_customer_id, status: 'all' })) {
        if (!ENDED.includes(sub.status)) await stripe.subscriptions.cancel(sub.id);
      }
      return true;
    } catch (e) {
      console.error('stripe cancel failed:', e.message);
      return false;
    }
  }

  const pendingCheckouts = queues.size; // for tests: logins with a checkout running or waiting
  return { checkout, portal, receive, cancel, pendingCheckouts };
}

module.exports = { createBilling, BadSignature };
