# Security rules

Loaded when a change touches auth, permissions, sessions, tokens, crypto, secrets or `.env`.
A change that reaches this file is `critical` tier: full verification, no shortcuts.

## Non-negotiable

- **Never weaken a check to make something pass.** If a test, lint rule, type or authorization
  check blocks you, the block is the finding. Fix the cause or report it — do not relax it.
- **Authentication is not authorization.** Knowing *who* the caller is says nothing about whether
  they may touch *this* record. Every new endpoint, handler, resolver, job and RPC needs both.
- **Authorize server-side, on the object.** Hiding a button, filtering a menu, or trusting a role
  claim in the request body is not authorization. Check ownership/tenancy against stored state.
- **Never log or return secrets.** Tokens, passwords, keys, full PII, and raw upstream errors stay
  out of logs, responses and error messages. Return an opaque error id instead.

## Every change here

1. **Enumerate the new surface.** List each route/handler/permission the diff adds or changes, and
   name the check that guards each. A surface with no named guard is a finding.
2. **Trace one hostile input** end to end: unauthenticated caller, wrong tenant, expired token,
   missing field, oversized payload. What happens at each hop?
3. **Deny by default.** New roles/permissions start with no access; grants are explicit. A missing
   or unknown role must fail closed, never fall through to allow.
4. **Validate at the trust boundary**, server-side, before use — type, range, length, and
   allow-list. Client-side validation is UX, not a control.
5. **Parameterise everything.** No string-built SQL, shell, path, template or LDAP. If you must
   build a command, allow-list the values.
6. **Secrets come from the environment/secret store**, never from source, fixtures, or test files.
   If a secret was ever committed, say so explicitly — it must be rotated, not just removed.

## Session and token specifics

- Rotate session/refresh tokens on privilege change (login, elevation, password change) and
  invalidate the old one server-side. Logout must revoke, not just delete a cookie.
- Set expiry on every credential. Verify signature **and** issuer/audience/expiry — decoding is not
  verifying, and "none"/weak algorithms must be rejected explicitly.
- Auth cookies: `HttpOnly`, `Secure`, and a `SameSite` value chosen deliberately.
- Compare secrets in constant time; hash passwords with a memory-hard KDF (argon2/bcrypt/scrypt),
  never a bare digest.

## Report, don't silently fix

If you find an existing vulnerability outside the task's scope, state it — file/line, what an
attacker gets, how to fix — and let the user decide. Do not expand the diff to chase it.
