# Module: taste-formatting

**Provider:** `design-taste-frontend` if installed (invoke it via the Skill tool), otherwise
this file.

Applies to **design artefacts only** — the UI you produce. It never governs response length.

> `taste-skill` also ships `full-output-enforcement`, which bans brevity. That rule is about
> *code completeness*, not prose. If both are active: write complete code, and still write a
> short response. They only conflict if you let the code rule leak into the reply.

## When this fires

`Y context` or `Y impact` named the `frontend` area, or the change touches components,
styles, pages, or design tokens. Backend-only work ignores this module entirely.

## If the provider is a skill

Invoke it and follow it. Yindee still owns the repo: `Y context` decides which files you
open, `Y impact` decides the tier, `Y verify` decides whether it passes. The skill decides
what the interface should look like.

## Fallback rules (provider = builtin)

1. **Read the brief before choosing an aesthetic.** Page kind, vibe words, named references.
   Defaulting to a generic look is the failure mode.
2. **Match the existing design system.** Read the tokens/theme file `context` named. Never
   introduce a second spacing scale, type scale, or colour ramp.
3. **Reuse the component that exists.** A new variant beats a new component; a new component
   beats a new dependency.
4. **States are part of the work.** Hover, focus-visible, disabled, loading, empty, error.
   An interface without them is unfinished, not minimal.
5. **Accessibility is not a polish pass.** Semantic elements, labels, contrast, keyboard
   order — never simplified away.

## Verification

Whatever this module changes still goes through `Y impact` → `Y verify`. Design taste never
substitutes for the tier's checks.
