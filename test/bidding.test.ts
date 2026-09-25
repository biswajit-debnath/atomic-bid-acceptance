import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { placeBid, closeAuction, createAuction, type NewAuction } from '../src/bidding.ts';

const config = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  socketPath: process.env.DB_SOCKET,
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? 'root',
  database: process.env.DB_NAME ?? 'bidding',
};

const pool = mysql.createPool({ ...config, connectionLimit: 20 });

const auction = (overrides: Partial<NewAuction> = {}) => createAuction(pool, {
  startPrice: 10_000_00,     // ₹10,000
  decrementStep: 100_00,     // ₹100
  endsInMs: 60_000,
  extensionWindowSec: 10,
  maxExtensions: 3,
  ...overrides,
});

const bid = (auctionId: number, bidderId: number, amount: number, bidId = randomUUID()) =>
  placeBid(pool, { bidId, auctionId, bidderId, amount });

before(async () => {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  const conn = await mysql.createConnection({ ...config, multipleStatements: true });
  await conn.query(schema);
  await conn.end();
});

after(() => pool.end());

test('first bid must be at or below the start price', async () => {
  const id = await auction();
  assert.deepEqual(await bid(id, 1, 10_500_00), { accepted: false, reason: 'BID_TOO_HIGH' });
  assert.equal((await bid(id, 1, 10_000_00)).accepted, true);
});

test('a bid must beat the current best by at least the decrement step', async () => {
  const id = await auction();
  await bid(id, 1, 9_000_00);
  assert.deepEqual(await bid(id, 2, 8_950_00), { accepted: false, reason: 'BID_TOO_HIGH' });
  assert.equal((await bid(id, 2, 8_900_00)).accepted, true);
});

test('200 concurrent bids at the same amount produce exactly one winner', async () => {
  const id = await auction();
  const results = await Promise.all(
    Array.from({ length: 200 }, (_, i) => bid(id, i + 1, 9_000_00)),
  );
  assert.equal(results.filter(r => r.accepted).length, 1);
  assert.ok(results.every(r => r.accepted || r.reason === 'BID_TOO_HIGH'));
});

test('100 concurrent distinct bids always settle on the lowest', async () => {
  const id = await auction();
  const amounts = Array.from({ length: 100 }, (_, i) => 10_000_00 - (i + 1) * 100_00);
  amounts.sort(() => Math.random() - 0.5);
  await Promise.all(amounts.map((amount, i) => bid(id, i + 1, amount)));

  const lowest = Math.min(...amounts);
  const [[row]] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT best_bid, best_bidder FROM auctions WHERE id = ?', [id],
  );
  assert.equal(Number(row.best_bid), lowest);
  assert.equal(Number(row.best_bidder), amounts.indexOf(lowest) + 1);
});

test('a retried bid returns the original result instead of bidding twice', async () => {
  const id = await auction();
  const bidId = randomUUID();
  const first = await bid(id, 1, 9_000_00, bidId);
  const replay = await bid(id, 1, 9_000_00, bidId);
  assert.deepEqual(replay, first);

  const [[{ n }]] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM bids WHERE bid_id = ?', [bidId],
  );
  assert.equal(Number(n), 1);
});

test('20 concurrent copies of the same bid are processed once', async () => {
  const id = await auction();
  const bidId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => bid(id, 1, 9_000_00, bidId)),
  );
  assert.ok(results.every(r => r.accepted));
  assert.ok(results.every(r => JSON.stringify(r) === JSON.stringify(results[0])));
});

test('bids after the end time are rejected', async () => {
  const id = await auction({ endsInMs: -1_000 });
  assert.deepEqual(await bid(id, 1, 9_000_00), { accepted: false, reason: 'AUCTION_ENDED' });
});

test('bids on a closed auction are rejected', async () => {
  const id = await auction({ endsInMs: -1_000 });
  assert.equal(await closeAuction(pool, id), true);
  assert.deepEqual(await bid(id, 1, 9_000_00), { accepted: false, reason: 'AUCTION_CLOSED' });
});

test('a bid in the final window extends the auction, up to the cap', async () => {
  const id = await auction({ endsInMs: 3_000, extensionWindowSec: 10, maxExtensions: 2 });
  const r1 = await bid(id, 1, 9_000_00);
  const r2 = await bid(id, 2, 8_900_00);
  const r3 = await bid(id, 3, 8_800_00);

  assert.ok(r1.accepted && r1.extended);
  assert.ok(r2.accepted && r2.extended);
  assert.ok(r3.accepted && !r3.extended, 'third extension should be blocked by the cap');
});

test('a bid outside the final window does not extend', async () => {
  const id = await auction({ endsInMs: 60_000, extensionWindowSec: 10 });
  const r = await bid(id, 1, 9_000_00);
  assert.ok(r.accepted && !r.extended);
});

test('closing is guarded: early and repeated closes are no-ops', async () => {
  const running = await auction({ endsInMs: 60_000 });
  assert.equal(await closeAuction(pool, running), false, 'should not close before end time');

  const ended = await auction({ endsInMs: -1_000 });
  assert.equal(await closeAuction(pool, ended), true);
  assert.equal(await closeAuction(pool, ended), false, 'second close should be a no-op');
});

test('a close that races a last-second extension loses', async () => {
  const id = await auction({ endsInMs: 300, extensionWindowSec: 5, maxExtensions: 1 });
  const r = await bid(id, 1, 9_000_00);
  assert.ok(r.accepted && r.extended);

  await new Promise(res => setTimeout(res, 400));   // original end time has now passed
  assert.equal(await closeAuction(pool, id), false, 'extension should keep it open');
});
