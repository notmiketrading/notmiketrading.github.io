# notmiketrading.github.io

The link page behind the bio link. One file, no build step, no dependencies, free to host.

**Live at:** https://notmiketrading.github.io

## Changing it

Everything is in `index.html`, and the instructions are in the file itself, just above the links.

The quickest way, which works from a phone:

1. Open `index.html` above
2. Click the pencil icon
3. Make the change
4. **Commit changes**

It is live in under a minute. Hard refresh if the old one is still showing.

- **A link moved?** Edit the `href="..."` on that block's first line.
- **Adding one?** Copy a whole block, `<a class="link">` through `</a>`, change the `href`, the text in `<b>`, and the line under it.
- **Removing one?** Delete its whole block.

## The discount row

The Killzonda row is the one with `class="link is-offer"`. The code lives in
`<span class="code">NMT</span>` and the badge in `<span class="tag">`.

If the offer ever changes, three things have to agree: the badge, the code on this page, and the
Stripe promotion code. A code that is advertised here and rejected at checkout is worse than no code
at all.

## Why the URL never changes

The bio link is set once. Everything on the page can be swapped without touching Instagram, which is
the whole point of hosting it here rather than putting a single destination in the bio.
