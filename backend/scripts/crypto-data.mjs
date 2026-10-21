import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { DEFAULT_CRYPTO_DATA_ROOT, verifyCryptoRelease, prepareCryptoRelease } from '../src/replay-crypto-data.js';
import { createFrozenOkxSource } from '../src/replay-crypto-session.js';
import { createOkxHistoryPoolSource } from '../src/replay-crypto-pool.js';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'data-root': { type: 'string' }, from: { type: 'string' }, kind: { type: 'string', default: 'sample' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('crypto-data.mjs status|check|prepare [--data-root DIR] [--kind sample|pool] [--from FROZEN_DATA_ROOT]\nstatus: runtime readiness; check: complete frozen raw/normalized/rule SHA256 chain; prepare: verified offline import, never copies a ledger.');
} else {
  try {
    if (positionals.length !== 1) throw new Error('Expected status, check or prepare; see --help');
    const dataRoot = resolve(values['data-root'] || process.env.INVESTFLOW_REPLAY_CRYPTO_DATA_ROOT || DEFAULT_CRYPTO_DATA_ROOT);
    let result;
    if (positionals[0] === 'status') result = createOkxHistoryPoolSource({ poolRoot: resolve(dataRoot, 'crypto-pool'), legacySource: createFrozenOkxSource({ dataRoot }) }).summary();
    else if (positionals[0] === 'check') result = verifyCryptoRelease({ dataRoot, kind: values.kind, published: true });
    else if (positionals[0] === 'prepare') result = prepareCryptoRelease({ from: values.from && resolve(values.from), dataRoot, kind: values.kind });
    else throw new Error('Unknown command; see --help');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(JSON.stringify({ code: error.code ?? 'CRYPTO_DATA_PREPARATION_FAILED', message: error.message })); process.exitCode = 1; }
}
