import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkedCryptoBytes, createCryptoAssetChecker, prepareCryptoRelease, verifyCryptoRelease, cryptoDataPath } from './replay-crypto-data.js';
import { createFrozenOkxSource } from './replay-crypto-session.js';
import { createOkxHistoryPoolSource } from './replay-crypto-pool.js';
test('F5 empty independent data root reports zero usable scenes rather than two fictitious samples', t => {
 const root = mkdtempSync(join(tmpdir(), 'crypto-f5-empty-')); t.after(() => rmSync(root, { recursive: true, force: true }));
 const source = createOkxHistoryPoolSource({ poolRoot: join(root, 'crypto-pool'), legacySource: createFrozenOkxSource({ dataRoot: root }) });
 assert.equal(source.summary().admittedWindows, 0);
 assert.equal(source.summary().mode, 'unavailable');
 assert.throws(() => source.load('BTC-USDT-SWAP'), e => e.code === 'REPLAY_SNAPSHOT_UNAVAILABLE');
});

function temp(t) { const root = mkdtempSync(join(tmpdir(), 'crypto-f5-integrity-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
test('F5 hash checks reject replaced, missing and escaped files even after a cached success', t => {
 const root = temp(t), outside = temp(t), bytes = Buffer.from('frozen');
 const ref = { file: 'part.gz', sha256: createHash('sha256').update(bytes).digest('hex') }, check = createCryptoAssetChecker();
 writeFileSync(join(root, ref.file), bytes); check(root, ref); assert.deepEqual(checkedCryptoBytes(root, ref), bytes);
 writeFileSync(join(root, ref.file), 'broken'); assert.throws(() => check(root, ref), e => e.code === 'REPLAY_SNAPSHOT_CORRUPT');
 rmSync(join(root, ref.file)); assert.throws(() => check(root, ref), e => e.code === 'REPLAY_SNAPSHOT_UNAVAILABLE');
 writeFileSync(join(outside, 'part.gz'), bytes); symlinkSync(join(outside, 'part.gz'), join(root, ref.file));
 assert.throws(() => checkedCryptoBytes(root, ref), e => e.code === 'REPLAY_SNAPSHOT_CORRUPT');
 for (const file of ['../escape', '/absolute', 'bad\\path', 'bad\0path']) assert.throws(() => cryptoDataPath(root, file), e => e.code === 'REPLAY_SNAPSHOT_CORRUPT');
});
test('F5 missing or counterfeit frozen manifests cannot be installed or published', t => {
 const from = temp(t), destination = join(temp(t), 'target');
 assert.throws(() => prepareCryptoRelease({ from, dataRoot: destination }), e => e.code === 'REPLAY_SNAPSHOT_UNAVAILABLE');
 assert.equal(existsSync(destination), false);
 const folder = join(from, 'crypto-samples/okx-20240101-v1'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'manifest.json'), '{}');
 assert.throws(() => verifyCryptoRelease({ dataRoot: from }), e => e.code === 'REPLAY_SNAPSHOT_CORRUPT');
 assert.throws(() => prepareCryptoRelease({ from, dataRoot: destination }), e => e.code === 'REPLAY_SNAPSHOT_CORRUPT');
 assert.equal(existsSync(destination), false);
 assert.equal(createFrozenOkxSource({ dataRoot: from }).summary().admittedWindows, 0);
});

test('F5 full published-pool check rejects a missing or foreign pointer before claiming readiness', t => {
 const root = temp(t);
 assert.throws(() => verifyCryptoRelease({ dataRoot: root, kind: 'pool', published: true }), e => e.code === 'REPLAY_SNAPSHOT_UNAVAILABLE');
 mkdirSync(join(root, 'crypto-pool'));
 writeFileSync(join(root, 'crypto-pool/current.json'), JSON.stringify({ file: 'foreign/catalog.json', sha256: 'a'.repeat(64) }));
 assert.throws(() => verifyCryptoRelease({ dataRoot: root, kind: 'pool', published: true }), e => e.code === 'REPLAY_SNAPSHOT_CORRUPT');
});
