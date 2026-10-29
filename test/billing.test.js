const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Stripe = require('stripe');

// fresh data folder before the db loads
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'puppypad-billing-'));
const { db } = require('../src/db');
const { createLogins } = require('../src/logins');
const { createBilling, BadSignature } = require('../src/billing');
const { fakeStripe } = require('./fake-stripe');

const DAY = 86400000;
const SECRET = 'whsec_billing';
const cfg = { ADMIN_EMAILS: new Set(), BASE_URL: 'http://pad.test', PRICE_ID: 'price_month', PRICE_ID_ANNUAL: 'price_year', QUOTA_MB: 1, MAX_FILE_MB: 1, SUPPORTER_QUOTA_MB: 3, SUPPORTER_MAX_FILE_MB: 2, HISTORY_DAYS: 30, SUPPORTER_HISTORY_DAYS: 365 };
const logins = createLogins({ cfg, removeSite: () => {}, holdName: () => {} });
const make = (stripe, c = cfg) => createBilling({ cfg: c, logins, stripe, webhookSecret: SECRET });

let n = 0;
const add = (fields = {}) => {
  const name = `pup${++n}`;
  const f = { username: name, email: `${name}@x.test`, login_id: null, stripe_customer_id: '', supporter_until: 0, ...fields };
  const { lastInsertRowid } = db.prepare("INSERT INTO users (username, email, pw_hash, verified, login_id, stripe_customer_id, supporter_until, created_at, updated_at) VALUES (@username, @email, 'h', 1, @login_id, @stripe_customer_id, @supporter_until, 0, 0)").run(f);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
};
const row = (u) => db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
const open = (id, customer, price) => ({ id, customer, url: `https://checkout.stripe.com/c/pay/${id}`, line_items: { data: [{ price: { id: price } }] } });
const secs = (ms) => Math.floor(ms / 1000);

// an event signed the way Stripe signs it; sub events also put the subscription in Stripe's state, as Stripe would hold it
const signer = new Stripe('sk_test_fake').webhooks;
function event(stripe, type, object, { secret = SECRET, store = true } = {}) {
  if (store && type.startsWith('customer.subscription.')) stripe.state.subs = stripe.state.subs.filter((o) => o.id !== object.id).concat(object);
  const payload = JSON.stringify({ id: `evt_${type}`, object: 'event', type, data: { object } });
  return make(stripe).receive(Buffer.from(payload), signer.generateTestHeaderString({ payload, secret }));
}

// a thin event, as an event destination sends it: a v2.core.event whose type is prefixed with v1. and which only
// points at the object; the object itself sits in Stripe's state, to be fetched by id
function thinEvent(stripe, type, object, { secret = SECRET } = {}) {
  if (type.startsWith('v1.customer.subscription.')) stripe.state.subs = stripe.state.subs.filter((o) => o.id !== object.id).concat(object);
  if (type.startsWith('v1.checkout.session.')) stripe.state.sessions = stripe.state.sessions.filter((o) => o.id !== object.id).concat(object);
  const payload = JSON.stringify({ id: `evt_${type}`, object: 'v2.core.event', type, related_object: { id: object.id, type: type.includes('checkout') ? 'checkout.session' : type.includes('subscription') ? 'subscription' : 'invoice', url: `/v1/${type.includes('checkout') ? 'checkout/sessions' : type.includes('subscription') ? 'subscriptions' : 'invoices'}/${object.id}` } });
  return make(stripe).receive(Buffer.from(payload), signer.generateTestHeaderString({ payload, secret }));
}

test('checkout makes the login one Stripe customer, picks the plan price, and opens Checkout', async () => {
  const stripe = fakeStripe();
  const billing = make(stripe);
  const login = add();
  const site = add({ login_id: login.id });
  assert.deepEqual(await billing.checkout(site, 'monthly'), { url: 'https://checkout.stripe.com/c/pay/test' }); // an extra site pays for its login
  const cus = row(login).stripe_customer_id;
  assert.match(cus, /^cus_test/);
  assert.equal(row(site).stripe_customer_id, '');
  const made = stripe.calls.at(-1);
  assert.equal(made.customer, cus);
  assert.equal(made.client_reference_id, String(login.id));
  assert.deepEqual(made.line_items, [{ price: 'price_month', quantity: 1 }]);
  assert.deepEqual(made.subscription_data, { metadata: { user_id: String(login.id) }, billing_mode: { type: 'flexible' } });

  await billing.checkout(row(login), 'annual'); // the login as the next request reads it
  assert.deepEqual(stripe.calls.at(-1).line_items, [{ price: 'price_year', quantity: 1 }]);
  assert.equal(stripe.state.customers, 1); // the second try found the customer already stored
  // a plan that isn't on offer takes the other price
  await make(stripe, { ...cfg, PRICE_ID_ANNUAL: '' }).checkout(row(login), 'annual');
  assert.deepEqual(stripe.calls.at(-1).line_items, [{ price: 'price_month', quantity: 1 }]);
  await make(stripe, { ...cfg, PRICE_ID: '' }).checkout(row(login), 'monthly');
  assert.deepEqual(stripe.calls.at(-1).line_items, [{ price: 'price_year', quantity: 1 }]);
});

test('checkout reuses an open checkout for the price on any page, and expires the others only when none match', async () => {
  const stripe = fakeStripe();
  const billing = make(stripe);
  const login = add({ stripe_customer_id: 'cus_open' });
  const others = Array.from({ length: 101 }, (_, i) => open(`cs_year_${i}`, 'cus_open', 'price_year'));
  stripe.state.open = [open('cs_elsewhere', 'cus_other', 'price_month'), ...others, open('cs_month', 'cus_open', 'price_month')];
  assert.deepEqual(await billing.checkout(login, 'monthly'), { url: 'https://checkout.stripe.com/c/pay/cs_month' });
  assert.equal(stripe.state.open.length, 103);

  stripe.state.open = [open('cs_elsewhere', 'cus_other', 'price_month'), ...others];
  assert.deepEqual(await billing.checkout(login, 'monthly'), { url: 'https://checkout.stripe.com/c/pay/test' });
  assert.deepEqual(stripe.state.open.map((o) => o.id), ['cs_elsewhere']); // the plan switched; another customer's stays
});

test('checkout refuses a second subscription while supporting or while one is live', async () => {
  const stripe = fakeStripe();
  const billing = make(stripe);
  assert.deepEqual(await billing.checkout(add({ stripe_customer_id: 'cus_a', supporter_until: Date.now() + DAY }), 'monthly'), { already: true });
  for (const status of ['active', 'trialing', 'past_due', 'incomplete']) {
    stripe.state.subs = [{ id: 'sub_x', customer: 'cus_b', status }];
    assert.deepEqual(await billing.checkout(add({ stripe_customer_id: 'cus_b' }), 'monthly'), { already: true }, status);
  }
  stripe.state.subs = [{ id: 'sub_x', customer: 'cus_b', status: 'canceled' }];
  assert.ok((await billing.checkout(add({ stripe_customer_id: 'cus_b' }), 'monthly')).url);
  stripe.state.fail = true;
  await assert.rejects(billing.checkout(add(), 'monthly'), /Stripe is down/);
});

test('portal opens the billing portal for a login Stripe knows, from any of its sites', async () => {
  const stripe = fakeStripe();
  const billing = make(stripe);
  const login = add({ stripe_customer_id: 'cus_portal' });
  assert.equal(await billing.portal(add({ login_id: login.id })), 'https://billing.stripe.com/p/session/test');
  assert.deepEqual(stripe.calls.at(-1), { customer: 'cus_portal', return_url: 'http://pad.test/dashboard/support' });
  assert.equal(await billing.portal(add()), null);
});

test('receive: forged events change nothing; checkout-completed links a login, never an extra site', async () => {
  const stripe = fakeStripe();
  const login = add();
  const site = add({ login_id: login.id });
  await assert.rejects(event(stripe, 'checkout.session.completed', { customer: 'cus_forged', client_reference_id: String(login.id) }, { secret: 'whsec_wrong' }), BadSignature);
  await assert.rejects(make(stripe).receive(Buffer.from('{}'), undefined), BadSignature);
  assert.equal(row(login).stripe_customer_id, '');
  await event(stripe, 'checkout.session.completed', { customer: 'cus_site', client_reference_id: String(site.id) });
  assert.equal(row(site).stripe_customer_id, '');
  await event(stripe, 'checkout.session.completed', { customer: 'cus_login', client_reference_id: String(login.id) });
  assert.equal(row(login).stripe_customer_id, 'cus_login');
});

test('receive: each subscription status sets how long the perks last', async () => {
  const stripe = fakeStripe();
  const login = add({ stripe_customer_id: 'cus_s' });
  const end = secs(Date.now() + 30 * DAY);
  const sub = (status, item) => ({ id: 'sub_s', customer: 'cus_s', status, metadata: {}, items: { data: [item] } });
  await event(stripe, 'customer.subscription.created', sub('active', { current_period_end: end }));
  assert.equal(row(login).supporter_until, end * 1000 + 3 * DAY);
  await event(stripe, 'customer.subscription.updated', sub('trialing', { current_period_end: end + 10 }));
  assert.equal(row(login).supporter_until, (end + 10) * 1000 + 3 * DAY);
  // a failed renewal moved the period on, but only the one before it was paid
  const renewed = secs(Date.now() - 5 * DAY);
  await event(stripe, 'customer.subscription.updated', sub('past_due', { current_period_start: renewed, current_period_end: renewed + 30 * 86400 }));
  assert.equal(row(login).supporter_until, renewed * 1000 + 3 * DAY);
  // an older API version keeps the period on the subscription itself
  await event(stripe, 'customer.subscription.updated', { id: 'sub_s', customer: 'cus_s', status: 'active', metadata: {}, current_period_end: end });
  assert.equal(row(login).supporter_until, end * 1000 + 3 * DAY);
  // a status that says nothing about payment changes nothing
  await event(stripe, 'customer.subscription.updated', sub('paused', { current_period_end: end }));
  assert.equal(row(login).supporter_until, end * 1000 + 3 * DAY);
  await event(stripe, 'customer.subscription.deleted', sub('canceled', { current_period_end: end }));
  assert.ok(row(login).supporter_until <= Date.now());
  const ended = row(login).supporter_until;
  await event(stripe, 'customer.subscription.updated', sub('unpaid', { current_period_end: end }));
  assert.equal(row(login).supporter_until, ended); // already over stays where it ended
});

test('receive: a stale event applies the subscription as Stripe holds it now', async () => {
  const stripe = fakeStripe();
  const login = add({ stripe_customer_id: 'cus_late' });
  const end = secs(Date.now() + 30 * DAY);
  await event(stripe, 'customer.subscription.deleted', { id: 'sub_late', customer: 'cus_late', status: 'canceled', metadata: {} });
  // an older "active" event arrives after the cancel; Stripe still holds the canceled subscription
  await event(stripe, 'customer.subscription.updated', { id: 'sub_late', customer: 'cus_late', status: 'active', metadata: {}, items: { data: [{ current_period_end: end }] } }, { store: false });
  assert.ok(row(login).supporter_until <= Date.now());
});

test('receive: a subscription whose customer matches no login changes nothing, whatever its metadata names', async () => {
  const stripe = fakeStripe();
  const login = add();
  const site = add({ login_id: login.id });
  const end = secs(Date.now() + 30 * DAY);
  await event(stripe, 'customer.subscription.created', { id: 'sub_m', customer: 'cus_m', status: 'active', metadata: { user_id: String(login.id) }, items: { data: [{ current_period_end: end }] } });
  assert.equal(row(login).stripe_customer_id, '');
  assert.equal(row(login).supporter_until, 0);
  await event(stripe, 'customer.subscription.created', { id: 'sub_e', customer: 'cus_e', status: 'active', metadata: { user_id: String(site.id) }, items: { data: [{ current_period_end: end }] } });
  assert.equal(row(site).stripe_customer_id, '');
  assert.equal(row(site).supporter_until, 0);
});

test('receive: a late event for a deleted login does not land on a new login that reuses its id', async () => {
  const stripe = fakeStripe();
  const old = add({ stripe_customer_id: 'cus_gone' });
  db.prepare('DELETE FROM users WHERE id = ?').run(old.id);
  db.prepare("INSERT INTO users (id, username, email, pw_hash, verified, created_at, updated_at) VALUES (?, 'reused', 'reused@x.test', 'h', 1, 0, 0)").run(old.id);
  const end = secs(Date.now() + 30 * DAY);
  await event(stripe, 'customer.subscription.updated', { id: 'sub_gone', customer: 'cus_gone', status: 'active', metadata: { user_id: String(old.id) }, items: { data: [{ current_period_end: end }] } });
  assert.equal(row(old).stripe_customer_id, '');
  assert.equal(row(old).supporter_until, 0);
});

test('receive: Stripe failing mid-event throws so Stripe retries it', async () => {
  const stripe = fakeStripe();
  const payload = JSON.stringify({ id: 'evt', object: 'event', type: 'customer.subscription.updated', data: { object: { id: 'sub_f' } } });
  stripe.state.fail = true;
  await assert.rejects(make(stripe).receive(Buffer.from(payload), signer.generateTestHeaderString({ payload, secret: SECRET })), (e) => !(e instanceof BadSignature));
});

test('cancel stops every subscription still billing, and says false when Stripe cannot be reached', async () => {
  const stripe = fakeStripe();
  const billing = make(stripe);
  const login = add({ stripe_customer_id: 'cus_c' });
  stripe.state.subs = [
    { id: 'sub_live', customer: 'cus_c', status: 'active' },
    { id: 'sub_late', customer: 'cus_c', status: 'past_due' },
    { id: 'sub_done', customer: 'cus_c', status: 'canceled' },
    { id: 'sub_gone', customer: 'cus_c', status: 'incomplete_expired' },
    { id: 'sub_other', customer: 'cus_other', status: 'active' },
  ];
  assert.equal(await billing.cancel(login), true);
  assert.deepEqual(stripe.state.cancelled, ['sub_live', 'sub_late']);
  assert.equal(await billing.cancel(add({ login_id: login.id, stripe_customer_id: 'cus_c' })), true); // an extra site pays for nothing
  assert.equal(await billing.cancel(add()), true); // Stripe doesn't know this login
  assert.equal(stripe.state.cancelled.length, 2);
  stripe.state.fail = true;
  const err = console.error;
  console.error = () => {};
  try { assert.equal(await billing.cancel(login), false); } finally { console.error = err; }
});

test('checkout finds a live subscription past the first ten', async () => {
  const stripe = fakeStripe();
  const old = Array.from({ length: 12 }, (_, i) => ({ id: `sub_old${i}`, customer: 'cus_many', status: 'canceled' }));
  stripe.state.subs = [...old, { id: 'sub_new', customer: 'cus_many', status: 'active' }];
  assert.deepEqual(await make(stripe).checkout(add({ stripe_customer_id: 'cus_many' }), 'monthly'), { already: true });
});

test('receive: a late cancel of an old subscription leaves the perks a newer paying one gave', async () => {
  const stripe = fakeStripe();
  const login = add({ stripe_customer_id: 'cus_two' });
  const end = secs(Date.now() + 30 * DAY);
  await event(stripe, 'customer.subscription.created', { id: 'sub_new', customer: 'cus_two', status: 'active', metadata: {}, items: { data: [{ current_period_end: end }] } });
  await event(stripe, 'customer.subscription.deleted', { id: 'sub_old', customer: 'cus_two', status: 'canceled', metadata: {} });
  assert.equal(row(login).supporter_until, end * 1000 + 3 * DAY);
  // once nothing else pays, the cancel ends them
  stripe.state.subs = stripe.state.subs.map((s) => ({ ...s, status: 'canceled' }));
  await event(stripe, 'customer.subscription.deleted', { id: 'sub_new', customer: 'cus_two', status: 'canceled', metadata: {} });
  assert.ok(row(login).supporter_until <= Date.now());
});

test('cancel also expires open checkouts, so a deleted login cannot start paying later', async () => {
  const stripe = fakeStripe();
  stripe.state.open = [open('cs_left', 'cus_x', 'price_month'), open('cs_theirs', 'cus_y', 'price_month')];
  assert.equal(await make(stripe).cancel(add({ stripe_customer_id: 'cus_x' })), true);
  assert.deepEqual(stripe.state.open.map((o) => o.id), ['cs_theirs']);
});

// as real Stripe does: a created checkout is open and listable until it is paid or expires
function keepCreated(stripe) {
  let made = 0;
  stripe.checkout.sessions.create = async (a) => {
    stripe.calls.push(a);
    const s = { id: `cs_made${++made}`, customer: a.customer, url: `https://checkout.stripe.com/c/pay/made${made}`, line_items: { data: [{ price: { id: a.line_items[0].price } }] } };
    stripe.state.open.push(s);
    return s;
  };
  return () => made;
}

test('two checkouts at once for one login give one session, from any of its sites', async () => {
  const stripe = fakeStripe();
  const made = keepCreated(stripe);
  const billing = make(stripe);
  const login = add({ stripe_customer_id: 'cus_race' });
  const site = add({ login_id: login.id });
  const [a, b] = await Promise.all([billing.checkout(login, 'monthly'), billing.checkout(site, 'monthly')]);
  assert.equal(a.url, b.url);
  assert.equal(made(), 1);
  assert.equal(billing.pendingCheckouts(), 0);
});

test('two checkouts at once for a login without a customer make one customer and one session', async () => {
  const stripe = fakeStripe();
  const made = keepCreated(stripe);
  const billing = make(stripe);
  const login = add();
  const [a, b] = await Promise.all([billing.checkout(login, 'monthly'), billing.checkout(login, 'monthly')]);
  assert.equal(a.url, b.url);
  assert.equal(stripe.state.customers, 1);
  assert.equal(made(), 1);
});

test('checkouts for different logins at once each get their own session', async () => {
  const stripe = fakeStripe();
  const made = keepCreated(stripe);
  const billing = make(stripe);
  // hold the first login's checkout inside a Stripe call; the second login's must finish meanwhile
  const list = stripe.subscriptions.list;
  let release;
  const held = new Promise((r) => { release = r; });
  stripe.subscriptions.list = (args) => (args.customer === 'cus_p' ? Object.assign(held.then(() => list(args)), { [Symbol.asyncIterator]: async function* () { await held; yield* list(args); } }) : list(args));
  const slow = billing.checkout(add({ stripe_customer_id: 'cus_p' }), 'monthly');
  const fast = await billing.checkout(add({ stripe_customer_id: 'cus_q' }), 'monthly');
  assert.ok(fast.url);
  assert.equal(made(), 1); // the held login hasn't got that far yet
  release();
  assert.notEqual((await slow).url, fast.url);
  assert.equal(made(), 2);
});

test('a checkout that throws reaches its caller and does not hold up the next one for that login', async () => {
  const stripe = fakeStripe();
  keepCreated(stripe);
  const billing = make(stripe);
  const login = add({ stripe_customer_id: 'cus_flaky' });
  const list = stripe.subscriptions.list;
  let first = true;
  stripe.subscriptions.list = (...a) => { if (first) { first = false; throw new Error('Stripe is down'); } return list(...a); };
  const [a, b] = await Promise.allSettled([billing.checkout(login, 'monthly'), billing.checkout(login, 'monthly')]);
  assert.equal(a.status, 'rejected');
  assert.match(a.reason.message, /Stripe is down/);
  assert.equal(b.status, 'fulfilled');
  assert.ok(b.value.url);
  assert.equal(billing.pendingCheckouts(), 0);
});

test('receive: thin events from an event destination drive the same changes as snapshots', async () => {
  const stripe = fakeStripe();
  const login = add({ stripe_customer_id: 'cus_thin' });
  const end = secs(Date.now() + 30 * DAY);
  await thinEvent(stripe, 'v1.customer.subscription.created', { id: 'sub_thin', customer: 'cus_thin', status: 'active', metadata: {}, items: { data: [{ current_period_end: end }] } });
  assert.equal(row(login).supporter_until, end * 1000 + 3 * DAY);
  await thinEvent(stripe, 'v1.customer.subscription.deleted', { id: 'sub_thin', customer: 'cus_thin', status: 'canceled', metadata: {} });
  assert.ok(row(login).supporter_until <= Date.now());

  const other = add();
  const site = add({ login_id: other.id });
  await thinEvent(stripe, 'v1.checkout.session.completed', { id: 'cs_thin', customer: 'cus_linked', client_reference_id: String(site.id) });
  assert.equal(row(site).stripe_customer_id, '');
  await thinEvent(stripe, 'v1.checkout.session.completed', { id: 'cs_thin2', customer: 'cus_linked', client_reference_id: String(other.id) });
  assert.equal(row(other).stripe_customer_id, 'cus_linked');
});

test('receive: a forged thin event changes nothing, and one Stripe fails to serve throws for a retry', async () => {
  const stripe = fakeStripe();
  const login = add();
  await assert.rejects(thinEvent(stripe, 'v1.checkout.session.completed', { id: 'cs_f', customer: 'cus_forged', client_reference_id: String(login.id) }, { secret: 'whsec_wrong' }), BadSignature);
  assert.equal(row(login).stripe_customer_id, '');
  stripe.state.fail = true;
  await assert.rejects(thinEvent(stripe, 'v1.customer.subscription.created', { id: 'sub_f', customer: 'cus_f', status: 'active', metadata: {} }), (e) => !(e instanceof BadSignature));
});

test('receive: a thin event of a kind the app ignores is a no-op, even with nothing to point at', async () => {
  const stripe = fakeStripe();
  const login = add({ stripe_customer_id: 'cus_i' });
  await thinEvent(stripe, 'v1.invoice.paid', { id: 'in_1' });
  const payload = JSON.stringify({ id: 'evt_bare', object: 'v2.core.event', type: 'v1.customer.subscription.created' });
  await make(stripe).receive(Buffer.from(payload), signer.generateTestHeaderString({ payload, secret: SECRET }));
  assert.equal(row(login).supporter_until, 0);
});

test('receive: Stripe events only move paid time, so an admin grant outlasts renewal, past_due and cancel', async () => {
  const stripe = fakeStripe();
  const login = add({ stripe_customer_id: 'cus_g' });
  const granted = Date.now() + 365 * DAY;
  db.prepare('UPDATE users SET supporter_granted_until = ? WHERE id = ?').run(granted, login.id);
  const end = secs(Date.now() + 30 * DAY);
  const sub = (status, item) => ({ id: 'sub_g', customer: 'cus_g', status, metadata: {}, items: { data: [item] } });
  await event(stripe, 'customer.subscription.updated', sub('active', { current_period_end: end }));
  assert.equal(row(login).supporter_until, end * 1000 + 3 * DAY);
  const renewed = secs(Date.now() - 5 * DAY);
  await event(stripe, 'customer.subscription.updated', sub('past_due', { current_period_start: renewed, current_period_end: renewed + 30 * 86400 }));
  assert.equal(row(login).supporter_until, renewed * 1000 + 3 * DAY);
  await event(stripe, 'customer.subscription.deleted', sub('canceled', { current_period_end: end }));
  assert.ok(row(login).supporter_until <= Date.now());
  assert.equal(row(login).supporter_granted_until, granted);
  assert.ok(logins.isSupporter(row(login)));
  assert.equal(logins.supporterUntil(row(login)), granted);
  assert.equal(logins.limitsFor(row(login)).quotaMB, cfg.SUPPORTER_QUOTA_MB);
});
