# 105. The first product issues, derived from the product spec (split)

Issue #422 asked for the product spec's first planned children, so that the
pipeline has product work to claim. That work is a breakdown, not one spec, so
this directory holds no `spec.md`; its number is not reused. See
[ADR 0016](../../docs/decisions/0016-product-breakdown-is-one-ordered-design.md).

- Design: [docs/designs/product-v0-build.md](../../docs/designs/product-v0-build.md),
  the product spec's breakdown into spec-sized children in the maintainer's
  milestone order (product spec section 12, design-tree R2.Q8).
- The product spec's own `## Children` section lists that design and one
  planned child beside it, `hardware-carrier-pcb`.

The scheduler files one `class:product` issue per planned child when the
design merges (spec 031) and closes issue #422; the work continues in those
issues.
