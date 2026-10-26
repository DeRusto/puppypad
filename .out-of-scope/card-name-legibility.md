# Guaranteeing a readable Site name on a styled card

Card style does not guarantee that a Site's name stays *readable* on its `/browse` card. It guarantees only that
the name and the `[profile]` link are never *hidden*, and that nothing a member writes reaches outside their own card.

## What is guaranteed

The `@layer guard` rules in `site.css` lock `display`, `visibility`, `opacity`, `clip-path`, `mask` and
`content-visibility` on the name, the `[profile]` link, their row and the card root. Containment (the outer card's
clip, `isolation`, `pointer-events: none` on pseudo-elements, the Supporter frame) is tested in Chromium and was
checked by hand in Firefox and Safari.

## What is not, and why

A member can still make their own name hard to read: `transform: scale(0)` on the card root, `filter`, a colour
that matches the background, a tiny `font-size`, or card art and `::before` content draped over it.

Locking these one by one doesn't work:

- `transform` on the card root is how the feature's hover effects work; the spec allows it on purpose.
- Locking `color` and `font-size` on the name would take away styling members are meant to use.
- Even with all of those locked, draped art can still sit on top of the name.

The only robust fix is moving the name and `[profile]` link out of the member's reach, into a platform strip in the
outer card painted above the art. That removes `name` as a Card part, rejects every saved style that targets it, and
takes away a large part of what members style. That's too much for the harm involved.

And the harm is small: an unreadable name only hurts the member's own card. At worst (`scale(0)` on the card root)
the whole card, links included, shrinks out of sight, which hides that Site from `/browse` and touches no one else's
card. The name and `[profile]` link stay in the markup, and an admin who finds a card abusive clears it with
**Admin → Card style → Clear card style** (the member sees the reason).

## Prior requests

- #164: "Card style can still make a Site name unreadable on its /browse card" (split out of #98 / PR #146's open question)
