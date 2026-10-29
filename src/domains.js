// Custom domains (GLOSSARY.md): a supporter's Site served at a hostname they own, while its subdomain 301s there.
const net = require('net');
const url = require('url');

// { host } as stored, matched and shown (the A-label), or { err } saying why it's refused
function normalise(input, baseHost) {
  let h = String(input ?? '').trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  const bad = { err: 'Type just the domain name, like example.com or www.example.com.' };
  if (!h || /[^\p{L}\p{N}.-]/u.test(h) || net.isIP(h)) return bad; // a scheme, port, path, *, space or IPv6 literal
  const a = url.domainToASCII(h); // also turns IPv4 spellings like 0x7f.1 into 127.0.0.1
  const labels = a.split('.');
  if (!a || net.isIP(a) || labels.length < 2 || a.length > 253 || labels.some((l) => !l || l.length > 63)) return bad;
  if (a === baseHost || a.endsWith(`.${baseHost}`)) return { err: `Addresses on ${baseHost} are ours already; pick a domain you own.` };
  return { host: a };
}

module.exports = { normalise };
