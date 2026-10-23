# PuppyPad

A free homepage host in the old-web style: every member gets a site at name.yourdomain and edits its files in the browser, over the HTTP API or with the CLI.

## Language

**Site**:
A member's homepage: one folder of files served at its own subdomain. A login has one site, and supporters may have up to five.
_Avoid_: account (that is the login), page

**Login**:
What a member signs in with. It owns one site (up to five for supporters) and holds the email, password, two-factor login, supporter status and admin rights for all of them.
_Avoid_: account, owner, user

**Supporter**:
A login whose support is current, paid through Stripe or granted by an admin. It gets the bigger limits and flair on all its sites; Supporter billing is the module that keeps that in step with Stripe.
_Avoid_: donor, subscriber, premium

**Site files**:
The module that owns a site's folder: every change to its files passes the site's limits and the phishing check and is kept in file history, usually with a feed event. It also creates, renames and removes whole sites.
_Avoid_: storage, uploads

**Card style**:
A site's own CSS that decorates only that site's card in the browse grid. Each site has its own; it never reaches the site itself, other cards or the rest of the page.
_Avoid_: explore CSS, pad CSS, card CSS

**Card part**:
One of the named pieces of a card that a card style may target: the card itself, its shot, name, tagline, tags and stats. Nothing else on the card is open to a card style.
_Avoid_: card element, card hook

**Card art**:
The images from a site's own files that its card style shows on its card. A card can only show images from its own site.
_Avoid_: card images, card assets
