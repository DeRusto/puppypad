// An in-memory Stripe for tests, shaped like the parts of the Stripe SDK that src/billing.js uses. Webhook signatures
// are checked by the real SDK (plain crypto), so a test signs events the way Stripe does.
// state: customers made, open checkouts and subscriptions per customer, ids cancelled, and fail to make every call throw.
// calls: the first argument of every call, newest last.
const Stripe = require('stripe');

// a list result that is also a promise of one page, as the SDK's are: `await list()` gives a page, `for await` walks them all
const listed = (data, limit = data.length) => Object.assign(Promise.resolve({ data: data.slice(0, limit), has_more: data.length > limit }), { [Symbol.asyncIterator]: async function* () { yield* data; } });

function fakeStripe() {
  const state = { customers: 0, open: [], subs: [], cancelled: [], fail: false };
  const calls = [];
  const call = (fn) => (...a) => { if (state.fail) throw new Error('Stripe is down'); calls.push(a[0]); return fn(...a); };
  return {
    state,
    calls,
    webhooks: new Stripe('sk_test_fake').webhooks,
    customers: { create: call(async () => ({ id: `cus_test${++state.customers}` })) },
    checkout: { sessions: {
      create: call(async () => ({ url: 'https://checkout.stripe.com/c/pay/test' })),
      list: call(({ customer, limit }) => listed(state.open.filter((o) => o.customer === customer), limit)),
      expire: call(async (id) => { state.open = state.open.filter((o) => o.id !== id); return { id }; }),
    } },
    subscriptions: {
      list: call(({ customer, limit }) => listed(state.subs.filter((o) => o.customer === customer), limit)),
      retrieve: call(async (id) => state.subs.find((o) => o.id === id)),
      cancel: call(async (id) => { state.cancelled.push(id); state.subs = state.subs.map((o) => (o.id === id ? { ...o, status: 'canceled' } : o)); return { id, status: 'canceled' }; }),
    },
    billingPortal: { sessions: { create: call(async () => ({ url: 'https://billing.stripe.com/p/session/test' })) } },
  };
}

module.exports = { fakeStripe };
