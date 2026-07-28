# Frontend rules

Loaded when a change touches components, pages, views, styles or client-side code.

## Every async surface has four states

Loading, empty, error, and success. A component that only renders the happy path is incomplete —
an unhandled rejection or an empty list must not render a blank screen or a spinner forever.

- Error states say what failed and offer the next action (retry, go back). Never surface a raw
  exception or a stack trace to the user.
- Empty is not an error: distinguish "no results yet", "no results for this filter", and "failed".

## Accessibility is part of done

- Every interactive element is reachable and operable by keyboard, with a visible focus style.
  A `div` with a click handler is not a button.
- Every control has an accessible name (label, `aria-label`, or text). Icon-only buttons always
  need one. Every image has `alt` (empty `alt=""` when decorative).
- Never signal state by colour alone. Body text needs 4.5:1 contrast, large text 3:1 — check it
  rather than eyeballing it.
- Respect `prefers-reduced-motion` for anything that moves.

## Correctness

- **Nothing secret reaches the client.** Any key, token or credential in client code — or in a
  build-time env var exposed to the bundle — is public. Server-side checks are the real control;
  hidden UI is not.
- Escape/encode anything user-supplied. Reaching for a raw-HTML injection API needs an explicit
  reason and sanitisation at the point of use.
- Keys in lists are stable ids, never array indices for reorderable data.
- Clean up subscriptions, timers, listeners and in-flight requests on unmount; guard against
  setting state after unmount and against out-of-order responses.
- Controlled vs uncontrolled inputs: pick one per field and keep it.

## Fitting in

- **Reuse the design system.** Use existing components, tokens and spacing/colour scales before
  writing new CSS. A hard-coded hex or one-off spacing value in a repo that has tokens is a finding.
- Match the repo's styling approach and component file layout. Do not introduce a second styling
  mechanism.
- Keep server/client boundaries explicit in frameworks that have them, and avoid pulling
  server-only modules into client bundles.

## Verifying

Assert on the DOM (text present, control enabled, request fired, contrast value) rather than
looking at screenshots — assertions say *which* thing broke and cost a fraction as much. Take a
screenshot only when asked how it looks, or when an assertion failed and the number doesn't explain
why.
