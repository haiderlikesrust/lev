/**
 * Read-only launch checks. Nothing is signed or sent.
 *  1. Collector Crypt: the documented endpoints this app uses answer, and an API key is set.
 *  2. Wallets: LEV_OPS and LEV_POOL load, differ, and have SOL and a USDC account.
 *  3. Fee split: Pullback's POOL wallet is configured so its transfers count as fee income.
 *
 *   npm run check
 */
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());
const { PublicKey } = await import('@solana/web3.js');
const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
const { config } = await import('../lib/server/config');
const { connection } = await import('../lib/server/chain');
const { loadSigner } = await import('../lib/server/signer');
const { CollectorCrypt } = await import('../lib/server/cc/client');
const { MACHINES } = await import('../lib/shared/machines');

const ok = (m: string) => console.log(`  ✓ ${m}`), warn = (m: string) => console.log(`  ✗ ${m}`);
console.log(`Mode: ${config.live ? 'MAINNET (real money)' : 'practice'}\n`);

console.log('1. Collector Crypt');
const cc = new CollectorCrypt(config.COLLECTOR_CRYPT_BASE_URL, config.COLLECTOR_CRYPT_API_KEY);
try {
  const machines = await cc.machines();
  ok(`/api/machines: ${machines.map(m => `${m.code} ($${m.priceUsd}, ${m.buybackPct}% buyback)`).join(', ')}`);
  const missing = MACHINES.filter(d => !machines.some(m => m.code === d.code));
  if (missing.length) warn(`Not in CC's catalog right now: ${missing.map(m => m.code).join(', ')}`);
  const open = await cc.openMachines();
  ok(`/api/status: ${MACHINES.filter(m => open.has(m.code)).length} of ${MACHINES.length} offered machines open`);
  ok(`/api/getAllWinners: ${(await cc.recentPulls(MACHINES[0].code, 5)).length} recent pulls on ${MACHINES[0].code}`);
} catch (error) { warn(`CC API: ${(error as Error).message}`); }
(config.COLLECTOR_CRYPT_API_KEY ? ok : warn)(config.COLLECTOR_CRYPT_API_KEY ? 'COLLECTOR_CRYPT_API_KEY is set' : 'COLLECTOR_CRYPT_API_KEY is not set: packs carry the generic `cc-` memo and are not attributed to us. Ask CC on Discord.');

console.log('\n2. Wallets');
const rpc = connection();
if (!rpc) warn('SOLANA_RPC_URL is not set.');
const signers = [['LEV_OPS', config.LEV_OPS_PRIVATE_KEY], ['LEV_POOL', config.LEV_POOL_PRIVATE_KEY]] as const;
const keys: string[] = [];
for (const [name, secret] of signers) {
  let signer;
  try { signer = loadSigner(`${name}_PRIVATE_KEY`, secret); } catch (error) { warn((error as Error).message); continue; }
  if (!signer) { warn(`${name}_PRIVATE_KEY is not set.`); continue; }
  keys.push(signer.publicKey.toBase58());
  if (!rpc) { ok(`${name} ${signer.publicKey.toBase58()}`); continue; }
  const ata = getAssociatedTokenAddressSync(new PublicKey(config.USDC_MINT), signer.publicKey);
  const [sol, account] = await Promise.all([rpc.getBalance(signer.publicKey), rpc.getAccountInfo(ata)]);
  (account && sol > 5_000_000 ? ok : warn)(`${name} ${signer.publicKey.toBase58()}: ${(sol / 1e9).toFixed(3)} SOL, USDC account ${account ? 'exists' : 'MISSING (create it before launch)'}`);
}
if (keys.length === 2 && keys[0] === keys[1]) warn('LEV_OPS and LEV_POOL must be different wallets.');

console.log('\n3. Fee split');
(config.PULLBACK_POOL_WALLET ? ok : warn)(config.PULLBACK_POOL_WALLET ? `Counting fee-split transfers from Pullback POOL ${config.PULLBACK_POOL_WALLET}` : 'PULLBACK_POOL_WALLET is not set: fee-split income will not be indexed.');
