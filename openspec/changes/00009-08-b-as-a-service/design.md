# Design — 00009-08: the storage boundary

## 1. Why a command-shaped API rather than a row-shaped one

The wire could have exposed tables — `POST /associations`, `PATCH /monitors/<id>` — and it would
have been simpler to write. It would also have destroyed the one property owner Rule B exists to
guarantee: that a block height's associations and its coverage advance commit **together**. With a
row-shaped API the client would issue N+1 requests and the atomicity would be the client's
problem, which is to say nobody's.

So the commands are the store's METHODS. `advance` is one call because it is one transaction;
`transition` is one call because a lifecycle change is one transaction with an epoch bump and a
lifecycle event in it; the details backfill is one call per BATCH, not per row, because the batch
is what the epoch fences. There is deliberately no branch in the router that performs two store
calls: a command whose atomicity the wire cannot promise is a command that should not exist.

The practical test of the design is that `PgShieldedMonitorStore` did not change. The server calls
exactly the method the client called, with the arguments the client passed.

## 2. The error round trip

`MonitorFencedError`, `MonitorNotFoundError`, `MonitorRevokedError`,
`IllegalLifecycleTransitionError` and `ValidationError` cross the wire as a code plus a small,
non-secret `detail` object, and the client rebuilds the SAME class with the SAME discriminants.
That is what lets every consumer above the store — the scanner's fence handling, the API's 403/404
mapping, the backfill's skip counting — hold either implementation without knowing which.

The one error that deliberately carries nothing is `InvalidViewingKeyError`: FR-001 requires every
intake failure to be one indistinguishable client error, so the rejection reason stays server-side.

An unrecognised code becomes a transport error, never the nearest store error. Inventing a
`MonitorNotFoundError` out of a proxy's 502 would be worse than a clear failure.

## 3. The lost response

In-process, a call threw or returned. Over HTTP there is a third outcome: it committed and the
answer was lost. `advance` is the only non-idempotent call whose result a caller acts on, so the
protocol lives there and nowhere else:

1. on a transport failure, **re-read the monitor**;
2. coverage at or past `throughHeight` → the batch committed; report `already-advanced`, which is
   exactly what the in-process store reports for a replayed batch (US5 scenario 2);
3. coverage short of it → the transaction is all-or-nothing, so it did not commit, and exactly one
   resend is safe;
4. the re-read fails too → throw. An unresolved outcome is never guessed at.

The monotonic coverage guard would have refused a blind resend anyway. The protocol does not rely
on that, because "it would have been refused" is a property of today's predicate and the claim
should not depend on it.

GETs are retried once, unconditionally: every route reached that way is a read.

## 4. Why the balancer is allowed to be random

The private API is stateless and its cursor is a per-monitor association sequence
(`shielded-monitor/api/cursor.ts`), not a server handle. A consumer may therefore be moved between
instances mid-scroll and still sees exactly the sequence it would have seen from one instance.
That is a property of the cursor design, and it is what makes "pick one at random" correct rather
than hopeful.

Random rather than round-robin: round-robin needs shared counter state to be fair across several
balancer processes, fairness is not a property anything here needs, and two round-robin balancers
restarted in phase send every request to the same instance. An independent uniform choice has no
state and no pathological interleaving.

A **GET** is retried once on another upstream; a **POST** never is. `POST /v1/monitors` registers
a viewing key and `POST …/pause` moves a lifecycle epoch — replaying either onto a second instance
would be the balancer inventing a request the consumer never made.

## 5. What the import guard proves, and what it does not

It proves that no module under `shielded-monitor/**` can reach `postgres`, `src/postgres/**` or
`storage-api/**` by any chain of imports, static or dynamic, with four planted positive controls.
Under the v1 design (organizer question Q24) the guard could only ban A's storage adapters,
because B owned a database and legitimately imported `src/postgres/client`; Q25 removed the
database, so the ban is now total and the documented dynamic-import exception is gone — the static
walk has no blind spot left.

It does NOT prove the code is absent from the image: `dist-cli/` ships `src/postgres/**` because
the `storage` command needs it. A hardened (TEE) build drops `dist-cli/storage-api`,
`dist-cli/chain-archive-sync` and `dist-cli/src/postgres`; nothing in B's code changes. The boot
refusal in `shielded-monitor/no-database.ts` covers the remaining operational gap — a leftover
credential in the environment.

## 6. Deviations from the sub-plan, recorded

- The details backfill is `POST /v1/monitor-store/monitors/<id>/association-details` with
  `{expectedEpoch, updates[]}`, not the sub-plan's `POST …/associations/<seq>/details`. The store
  fences a whole batch in one transaction; a per-seq route would make one transaction per row and
  lose the fence's meaning.
- `umbradb-archive-read-api` is KEPT as its own bin rather than folded away. The storage API mounts
  the same router, so there is one implementation; an archive-only port stays deployable, and the
  46 tests that already cover those routes keep their subject.
