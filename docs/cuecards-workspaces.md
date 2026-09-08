# Cuecards hosted workspaces

## Scope and decisions

- A user owns one private personal workspace and can own or join team workspaces.
- Owner: manage repositories, settings, members and invitations. Admin: manage
  repositories and member invitations/removal. Member: read workspace data.
- Personal workspaces cannot invite members. Team invitations are explicit,
  single-use bearer links, valid for seven days, not email-identity assertions.
  Share them privately: any signed-in person with the link can accept it.
- TanStack Router owns browser navigation; TanStack Query owns authenticated
  server data. Keep BetterAuth, PostgreSQL and the Vercel API rather than migrate
  the working local Bun dashboard to a second server framework. This is Router
  + Query, not a claim that the application uses TanStack Start.
- GX runs in a checkout or CI runner, never an arbitrary shell inside the
  hosted web server. Repository credentials are workspace-scoped; never reuse
  the deployment operator's GitHub login for customers.
- Auto-merge must fail closed unless GitHub enforces required checks and review.
  Enabling repository auto-merge capability is not permission to bypass gates.

## Security and acceptance checks

Every workspace read/write resolves the authenticated user and checks membership
in PostgreSQL. Browser IDs and roles are untrusted. Transactions lock workspace
rows before checking mutable roles. Owner membership is not removable or
demotable. Invitations store only SHA-256 token hashes and are consumed atomically;
the issuer must still have permission when they are accepted.

Cookie mutations require an allowed Origin. JSON schemas reject unknown fields;
bodies are bounded. Responses are private/no-store and never contain credentials,
invite hashes or raw database/provider errors. Query keys include user identity.

Tests must prove: private workspace idempotency, cross-user isolation, invitation
accept/replay/expiry/revocation, admin escalation denial, owner preservation, and
two-account browser navigation. Database changes are additive, versioned migrations.

## Running locally

Run the existing auth migration first. Set DATABASE_URL and BETTER_AUTH_SECRET,
then run `bun web/scripts/migrate-workspaces.ts`. Start the auth server and Vite
with matching BETTER_AUTH_URL / BETTER_AUTH_TRUSTED_ORIGINS.

Database tests use an explicitly supplied disposable WORKSPACES_TEST_DATABASE_URL;
they create and drop only their own random PostgreSQL schema. Never point this
variable at production. Normal tests still run schema/transport checks without it.

The auth migration command uses `getMigrations(auth.options)` from the installed
BetterAuth package, not an independently versioned CLI. Verify clean installs
with `BASE=http://localhost:3000 bun web/scripts/check-workspaces-flow.ts`.
An existing incompatible auth schema needs its own reviewed forward migration;
the workspace migrations do not alter existing auth tables.

## GitHub / GX connection

Connect a repository using its administrator's repository-scoped fine-grained
token: Contents, Pull requests, Webhooks read/write and Administration read.
The hosted service validates administrator access, stores an AES-256-GCM encrypted
credential bound to the workspace/connection IDs, and never returns it.
Only workspace owners/admins can use or remove that delegated integration.

Enable native auto-merge and squash in GitHub, then configure classic default
branch protection with required checks, strict up-to-date branches, at least one
approving review, stale-approval dismissal, enforcement for admins and no review
bypass allowances. Ruleset-only configurations currently fail closed.
Clicking Enable auto-enrollment verifies those gates and installs a signed
`pull_request` webhook at `BETTER_AUTH_URL/api/gx-hook`. Every eligible event
rechecks live policy and PR state. Only non-draft same-repository PRs to the current
default branch qualify. Closed/fork/draft PRs are skipped. Existing PRs can be
queued explicitly by number.

Pause stops NEW enrollment, not already queued native GitHub merges. Disconnect
forgets the stored token and makes its old webhook inert; remove the webhook and
revoke the token in GitHub separately. These effects are explained before action.
Failed deliveries/provider outages are visible as a safe status code; use the
explicit queue action or GitHub delivery redelivery after fixing the cause.

Encryption and webhook keys are domain-separated derivatives of BETTER_AUTH_SECRET.
Rotating that secret requires reconnecting repositories (disconnect still works
without decrypting). Never copy operator GitHub credentials into customer records.
The webapp does not execute arbitrary GX shell commands. Run GX's gated finish
in the checkout/runner; hosted auto-enrollment complements, not replaces, that gate.

## Deployment

1. Green workspace-isolation CI includes PostgreSQL, real auth signup and two-user
   HTTP checks; frontend typecheck/build and browser desktop/mobile checks.
2. Apply `workspaces:migrate` against the target database. Both versioned migrations
   are additive and guarded by a transaction, advisory lock and migration ledger.
3. Deploy the web project, verify unauthenticated API 401, login, workspace
   isolation and deep-link refresh. Do not initialize/migrate from public requests.
4. Verify an actual protected disposable GitHub repository before claiming live
   auto-merge behavior. Unit/handler tests mock GitHub and are not that proof.
