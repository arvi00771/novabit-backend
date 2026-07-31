/** BIP39/BIP44 deposit address derivation. Private keys never leave this module. */
import { mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { HDNodeWallet } from 'ethers';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { BIP32Factory } from 'bip32';
import { bech32 } from 'bech32';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { config } from '../config/index.js';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const COIN_TYPES: Record<string, number> = {
  BTC: 0, ETH: 60, ERC20: 60, USDT: 60, USDC: 60, BSC: 60, BEP20: 60,
  SOL: 501, TRX: 195, TRC20: 195, ADA: 1815, DOT: 354,
};

export interface DerivedAddress { address: string; derivationPath: string; memo: string | null }

function indexForUser(userId: string): number {
  // Stable non-zero BIP44 address index derived from the user identifier.
  let h = 2166136261;
  for (const c of userId) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) % 2_000_000_000;
}
function pathFor(asset: string, index: number): string {
  const coin = COIN_TYPES[asset] ?? COIN_TYPES[asset.toUpperCase()];
  if (coin === undefined) throw new Error(`Unsupported HD wallet asset: ${asset}`);
  return `m/44'/${coin}'/0'/0/${index}`;
}
// ed25519-hd-key requires every segment to be hardened (end with ')
function ed25519Path(asset: string, index: number): string {
  const coin = COIN_TYPES[asset] ?? COIN_TYPES[asset.toUpperCase()];
  if (coin === undefined) throw new Error(`Unsupported HD wallet asset: ${asset}`);
  return `m/44'/${coin}'/0'/0'/${index}'`;
}
function seed(): Buffer {
  if (!validateMnemonic(config.WALLET_SEED)) throw new Error('WALLET_SEED must be a valid BIP39 mnemonic');
  return mnemonicToSeedSync(config.WALLET_SEED);
}

export async function deriveDepositAddress(assetInput: string, _network: string, userId: string): Promise<DerivedAddress> {
  const asset = assetInput.toUpperCase();
  const index = indexForUser(userId);
  const path = pathFor(asset, index);
  const mnemonic = config.WALLET_SEED;
  const rawSeed = seed();
  let address: string;

  if (asset === 'BTC') {
    const node = bip32.fromSeed(rawSeed, bitcoin.networks.bitcoin).derivePath(path.replace("m/44'", "m/84'"));
    address = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.publicKey), network: bitcoin.networks.bitcoin }).address!;
  } else if (['ETH', 'ERC20', 'USDT', 'USDC', 'BSC', 'BEP20'].includes(asset)) {
    address = HDNodeWallet.fromPhrase(mnemonic, undefined, path).address;
  } else if (asset === 'SOL') {
        const edPath = ed25519Path(asset, index);
        const derived = derivePath(edPath, rawSeed.toString('hex'));
        address = Keypair.fromSeed(derived.key).publicKey.toBase58();
  } else if (asset === 'TRX' || asset === 'TRC20') {
    // Tron uses secp256k1 and the same BIP44 private key as Ethereum, but a Base58Check prefix.
    const node = bip32.fromSeed(rawSeed).derivePath(path);
    const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from((await import('ethers')).computeAddress(`0x${Buffer.from(node.privateKey!).toString('hex')}`).slice(2), 'hex')]);
    const checksum = (await import('node:crypto')).createHash('sha256').update((await import('node:crypto')).createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
    address = bs58.encode(Buffer.concat([payload, checksum]));
  } else if (asset === 'DOT') {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519', ss58Format: 0 });
    address = keyring.addFromUri(`${mnemonic}//${index}`).address;
  } else if (asset === 'ADA') {
        // Shelley enterprise address: network id 1 (mainnet) and key-hash payload.
        const edPath = ed25519Path(asset, index);
        const derived = derivePath(edPath, rawSeed.toString('hex'));
    const hash = (await import('node:crypto')).createHash('blake2b512').update(derived.key).digest().subarray(0, 28);
    address = bech32.encode('addr', bech32.toWords(Buffer.concat([Buffer.from([0x61]), hash])));
  } else {
    throw new Error(`Unsupported HD wallet asset: ${asset}`);
  }
  const memo = ['XRP', 'EOS', 'XLM', 'ATOM'].includes(asset) ? String(index) : null;
  return { address, derivationPath: path, memo };
}
