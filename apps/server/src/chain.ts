import { parseAbi, parseAbiItem } from "viem";

/** Official QIE mainnet contracts (chain 1990), from qie.digital/developers and the QIE Wallet MCP token list. */
export const QIE_MAINNET = {
  QUSDC: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5",
  WQIE: "0x0087904D95BEe9E5F24dc8852804b547981A9139",
  WETH: "0xAC8d365ECc9074a679f75B3E6b2bbF303e466728",
  QIEDEX_FACTORY: "0x8e23128a5511223be6c0d64106e2d4508c08398c",
  QIEDEX_ROUTER: "0x08cd2e72e156d8563b4351eb4065c262a9f553ef",
} as const;

export type TokenInfo = { address: `0x${string}` | null; symbol: string; decimals: number; official?: boolean };

export const NATIVE_TOKEN: TokenInfo = { address: null, symbol: "QIE", decimals: 18, official: true };

/** Tokens we know without an RPC call. Lower-cased keys. */
export const KNOWN_TOKENS: Record<string, TokenInfo> = {
  [QIE_MAINNET.QUSDC.toLowerCase()]: { address: QIE_MAINNET.QUSDC, symbol: "QUSDC", decimals: 6, official: true },
  [QIE_MAINNET.WQIE.toLowerCase()]: { address: QIE_MAINNET.WQIE, symbol: "WQIE", decimals: 18, official: true },
  [QIE_MAINNET.WETH.toLowerCase()]: { address: QIE_MAINNET.WETH, symbol: "WETH", decimals: 18, official: true },
};

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
export const SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
);
export const SUBSCRIBED_EVENT = parseAbiItem(
  "event Subscribed(address indexed account, uint8 indexed planId, uint32 periods, uint256 amount, uint64 paidUntil)",
);

export const TOPIC = {
  TRANSFER: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  SWAP: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  /** Uniswap V2 / QIEDEX pair: emitted with the new reserves after every mint, burn and swap. */
  SYNC: "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
} as const;

export const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export const PAIR_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

export const BILLING_ABI = parseAbi([
  "function subscribe(uint8 planId, uint32 periods, uint256 maxAmount)",
  "function paidUntil(address) view returns (uint64)",
  "function plans(uint8) view returns (uint256 price, uint32 duration, bool active)",
  "function token() view returns (address)",
]);

export type RpcLog = {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
  transactionIndex: `0x${string}`;
  logIndex: `0x${string}`;
  blockHash: `0x${string}`;
  removed?: boolean;
};

export type RpcTx = {
  hash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}` | null;
  value: `0x${string}`;
  input: `0x${string}`;
  transactionIndex: `0x${string}`;
  blockNumber: `0x${string}`;
};

export type RpcBlock = {
  number: `0x${string}`;
  hash: `0x${string}`;
  timestamp: `0x${string}`;
  transactions: RpcTx[] | `0x${string}`[];
};

export type RpcReceipt = { status: `0x${string}`; transactionHash: `0x${string}` };

export const hexToNum = (h: string): number => Number.parseInt(h, 16);
export const numToHex = (n: number): `0x${string}` => `0x${n.toString(16)}`;
