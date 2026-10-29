# PuppyPad

A free homepage host in the old-web style: every member gets a site at name.yourdomain and edits its files in the browser, over the HTTP API or with the CLI.

## Language

**Site**:
A member's homepage: one folder of files served at its own subdomain. A login has one site, and supporters may have up to five.
_Avoid_: account (that is the login), page

**Online**:
A Site anyone can visit: its login confirmed the email and no moderator has taken it down.
_Avoid_: live, active, published

**Listed**:
An Online Site shown in the dog park, on the home page, in the sitemap and in the webring. It is listed once it isn't hidden, has been edited at least once, and is past the new-site wait.
_Avoid_: visible, public, discoverable

**Taken down**:
A Site a moderator took offline for breaking the rules. Visitors see that it was removed, editing stops and its login is signed out. Taking a login down takes its extra sites with it. Restoring the login brings back only those, never one a moderator took down on its own, and no extra site comes back while its login is down.
_Avoid_: banned, suspended

**Held name**:
A name a Site gave up, by being deleted or renamed, that nobody else can claim for 90 days. A renamed Site's old held name sends visitors to its new address, and its own login may take that name back.
_Avoid_: released name, reserved name (reserved names are the ones no Site may ever take)

**Custom domain**:
A hostname a supporter owns and serves one of their Sites at, proved by a TXT record and pointed at `BASE_DOMAIN`. While it is live, the Site's subdomain sends visitors there. A Site has at most one; a claim on it is pending, verified, live, failing, or ended.
_Avoid_: vanity domain, own domain

**Login**:
What a member signs in with. It owns one site (up to five for supporters) and holds the email, password, two-factor login, supporter status and admin rights for all of them.
_Avoid_: account, owner, user

**Session**:
A request's hold on a site: a browser signed in to its login, or the site's API key. It stays good only while everything it started with still holds: the password, the site's name, the key, and the site not being taken down.
_Avoid_: auth, credential, token (a token is a one-use emailed link or the second login step)

**Supporter**:
A login whose support is current. It has two kinds of time: *paid time*, which only Stripe moves, and *granted time*, which only an admin sets. Support lasts until the later of the two. It gets the bigger limits and flair on all its sites; Supporter billing is the module that keeps that in step with Stripe.
_Avoid_: donor, subscriber, premium

**Site files**:
The module that owns a site's folder: every change to its files passes the site's limits and the phishing check and is kept in file history, usually with a feed event. It also creates, renames and removes whole sites.
_Avoid_: storage, uploads

**Update**:
The entry a Site's file changes make in the feed. Followers see it, and members can comment on it and like it. Changes within an hour of the last Update join that Update.
_Avoid_: event, post, activity

**Block**:
One member shutting another out. While either has blocked the other, neither can follow, comment on or like the other's Site, and the follows between them end. The blocked member's comments and likes are hidden on the blocker's Site and from the blocker's view.
_Avoid_: mute, ban (that is a Site being taken down)

**Guestbook**:
A Site's visitor book, where anyone can sign without a login. Entries with a link wait for the owner's approval, and the owner can block words and visitors' addresses.
_Avoid_: comments (those are members' and sit on profiles and Updates)

**Card style**:
A site's own CSS that decorates only that site's card in the browse grid. Each site has its own; it never reaches the site itself, other cards or the rest of the page.
_Avoid_: explore CSS, pad CSS, card CSS

**Card part**:
One of the named pieces of a card that a card style may target: the card itself, its shot, name, tagline, tags and stats. Nothing else on the card is open to a card style.
_Avoid_: card element, card hook

**Card art**:
The images from a site's own files that its card style shows on its card. A card can only show images from its own site.
_Avoid_: card images, card assets

**Stock card**:
A site's card in the browse grid as it looks with no card style. A site with a card style shows the stock card instead whenever that style is rejected or any of its card art fails to load.
_Avoid_: default card, plain card, fallback card
