# Atomic bid acceptance for a reverse auction

A small reconstruction of the bid acceptance path I rebuilt while working on a freight
bidding engine at SuperProcure. The original code is proprietary, so this repo recreates
the core design on its own, with tests.

## The problem

Transporters bid *down* on a load; the lowest bid wins. Traffic is spiky: most bids land in
the last minute of an auction. That's exactly when the original implementation broke.

It followed the obvious shape:

1. Read the auction's current best bid
2. Check the new bid in application code
3. Write the new best bid

Two bidders who both read "best = ₹10,000" can both pass the check and both write. The
auction ends up with two winners, or with a best bid that's higher than one that was
already accepted.

## The rule

A bid is accepted only if **all** of these hold at the same instant:

- the auction is open
- the server's clock is before the end time
- the bid is at or below the start price (first bid), or beats the current best by at least
  the decrement step

Checking them and recording the bid has to be one indivisible step.

## The approach

**One guarded write, no read first.** The whole rule lives in the `WHERE` clause of a single
`UPDATE`. If it matches, the bid is accepted. If it affects zero rows, it's rejected. When
two bids race, InnoDB makes the second wait for the first's row lock, then re-evaluates the
`WHERE` against the updated row, so it's correctly rejected. The database clock (`NOW(3)`)
decides timing, never the client's.

**Anti-sniping inside the same transaction.** A bid in the final window pushes the end
time out, up to a cap. It runs while we still hold the row lock from the accept, so the
auction can't close between accepting the bid and extending it.

**Idempotent retries.** The client generates `bidId` and reuses it on retry. It's the
primary key of `bids`, so a double-click or a network retry hits a duplicate key and gets
back the original result instead of placing a second bid.

**Closing is a guarded write too.** `UPDATE ... WHERE status = 'OPEN' AND end_time <= NOW(3)`.
Whatever triggers the close can fire late, early or twice. If the auction was extended in
the meantime, the close affects zero rows and simply tries again later.

### Alternatives I considered

- **`SELECT ... FOR UPDATE`, then check, then write.** Correct, but it holds the lock across
  a round trip to the application and back. Under last-minute load, that's the lock hold
  time you can least afford.
- **Optimistic locking with a version column.** Works well at low contention, but auction
  close is maximum contention, so most attempts would fail and retry.

The guarded update gets the correctness of the first with the lock held for only as long
as the database needs.

## Evidence

`test/bidding.test.ts` runs against a real MySQL database. The key tests:

- 200 concurrent bids at the same amount → exactly one accepted
- 100 concurrent bids at different amounts, in random order → always settles on the lowest
- 20 concurrent copies of the same `bidId` → processed once
- a close racing a last-second extension → the extension wins

Swapping the guarded write for the naive read-check-write version makes the first test
accept **20 winners out of 200** instead of one.

## Running it

```bash
npm install
npm run db:up        # MySQL 8 in Docker
npm test
```

Connection settings can be overridden with `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`,
`DB_NAME` or `DB_SOCKET`.

## Out of scope

The production system had more around this core: caching the auction's fixed rules so the
hot path didn't re-read them, pushing updates to connected bidders over WebSockets, and
bidder eligibility checks. This repo focuses on the part that has to be correct under
concurrency.

Money is stored as integer paise throughout.
