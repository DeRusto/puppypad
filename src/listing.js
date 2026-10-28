// Site listing: which Sites are Online, which of those are not hidden, and which are Listed (on the home page, the dog
// park, the sitemap, /random and the webring). Each rule exists once as SQL, for queries on users (unaliased columns),
// and once as JS for a row in hand; test/listing.test.js keeps the two in step.
const ONLINE = 'verified = 1 AND banned = 0';

function createListing({ cfg }) {
  // a new Site is Listed only after its first edit and once it is NEW_SITE_HOURS old, so throwaway spam gets no audience
  const listedSince = () => Math.floor(Date.now() - cfg.NEW_SITE_HOURS * 3600000);
  // Online and not hidden: the follow feed and weekly digest show these even before they are Listed
  const unhiddenWhere = () => `${ONLINE} AND hidden = 0`;
  const listedWhere = () => `${unhiddenWhere()} AND updates > 0 AND created_at <= ${listedSince()}`;
  const isOnline = (site) => !!(site.verified && !site.banned);
  const isListed = (site) => isOnline(site) && !site.hidden && site.updates > 0 && site.created_at <= listedSince();
  return { ONLINE, unhiddenWhere, listedWhere, isOnline, isListed };
}

module.exports = { createListing, ONLINE };
