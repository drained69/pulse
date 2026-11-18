import type { Me } from "./api.ts";

export type FormState = {
  name: string;
  type: TriggerType;
  channel: "webhook" | "telegram" | "discord";
  recipient: string;
  assetQIE: boolean;
  assetQUSDC: boolean;
  extraTokens: string;
  anyToken: boolean;
  minAmount: string;
  token: string;
  from: string;
  to: string;
  pair: string;
  minUsd: string;
  contract: string;
  events: string;
  filters: string;
  walletAddr: string;
  direction: "both" | "in" | "out";
  includeFailed: boolean;
  includeTokens: boolean;
  balAddr: string;
  balAsset: string;
  balDir: "below" | "above";
  balAmount: string;
  priceToken: string;
  priceDir: "above" | "below";
  priceValue: string;
  watchName: string;
  digestSource: string;
  digestHour: string;
};

export type TriggerType = "payment" | "token_transfer" | "swap" | "contract_event" | "wallet" | "balance" | "price" | "name_watch" | "daily_digest" | "invoice";

export const EMPTY_FORM: FormState = {
  name: "",
  type: "payment",
  channel: "telegram",
  recipient: "",
  assetQIE: true,
  assetQUSDC: true,
  extraTokens: "",
  anyToken: false,
  minAmount: "",
  token: "QUSDC",
  from: "",
  to: "",
  pair: "",
  minUsd: "",
  contract: "",
  events: "",
  filters: "",
  walletAddr: "",
  direction: "both",
  includeFailed: true,
  includeTokens: true,
  balAddr: "",
  balAsset: "QIE",
  balDir: "below",
  balAmount: "",
  priceToken: "WQIE",
  priceDir: "above",
  priceValue: "",
  watchName: "",
  digestSource: "",
  digestHour: "8",
};

export const QIEDEX_FACTORY = "0x8e23128a5511223be6c0d64106e2d4508c08398c";

/** Safe 1.3 and 1.4 differ in which owner args are indexed; listing both covers either deployment. */
const SAFE_EVENTS = [
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
  "event AddedOwner(address owner)",
  "event AddedOwner(address indexed owner)",
  "event RemovedOwner(address owner)",
  "event RemovedOwner(address indexed owner)",
  "event ChangedThreshold(uint256 threshold)",
  "event SafeReceived(address indexed sender, uint256 value)",
  "event ApproveHash(bytes32 indexed approvedHash, address indexed owner)",
];

const ADMIN_EVENTS = [
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event Upgraded(address indexed implementation)",
  "event AdminChanged(address previousAdmin, address newAdmin)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
];

export type Template = {
  id: string;
  icon: string;
  title: string;
  who: string;
  desc: string;
  apply: (me: Me | null) => Partial<FormState>;
};

export const TEMPLATES: Template[] = [
  {
    id: "checkout",
    icon: "🧾",
    title: "Payment link paid",
    who: "Merchants",
    desc: "Fulfil orders automatically when a customer pays one of your payment links.",
    apply: () => ({ type: "invoice", name: "Payment link paid" }),
  },
  {
    id: "shop",
    icon: "🛍️",
    title: "Shop payments",
    who: "Merchants",
    desc: "Message staff when someone pays your name.qie in QIE or QUSDC.",
    apply: (me) => ({ type: "payment", recipient: me?.user.qieName ?? "", name: "Shop payments" }),
  },
  {
    id: "digest",
    icon: "🗓️",
    title: "Daily sales summary",
    who: "Merchants",
    desc: "Every morning: count, totals and top payers from another hook.",
    apply: () => ({ type: "daily_digest", name: "Daily summary", digestHour: "7" }),
  },
  {
    id: "wallet",
    icon: "👛",
    title: "Watch a wallet",
    who: "Everyone",
    desc: "Everything in and out of an address, including failed transactions.",
    apply: (me) => ({ type: "wallet", walletAddr: me?.user.qieName ?? me?.user.address ?? "", name: "My wallet activity" }),
  },
  {
    id: "gas",
    icon: "🪫",
    title: "Low gas wallet",
    who: "Developers",
    desc: "Alert when a relayer or bot wallet drops below a QIE balance.",
    apply: (me) => ({ type: "balance", balAddr: me?.user.address ?? "", balAsset: "QIE", balDir: "below", balAmount: "5", name: "Gas wallet low" }),
  },
  {
    id: "admin",
    icon: "🛡️",
    title: "Contract admin changes",
    who: "Developers",
    desc: "Paused, upgraded, ownership or roles changed on your contract.",
    apply: () => ({ type: "contract_event", events: ADMIN_EVENTS.join("\n"), name: "Admin changes" }),
  },
  {
    id: "failed",
    icon: "⛔",
    title: "Failed calls to my contract",
    who: "Developers",
    desc: "Every transaction into your contract, flagged when it reverts.",
    apply: () => ({ type: "wallet", direction: "in", includeTokens: false, includeFailed: true, name: "Calls to my contract" }),
  },
  {
    id: "safe",
    icon: "🔐",
    title: "Watch my Safe",
    who: "Treasuries",
    desc: "QIE Safe multisig: executions, failures, owner and threshold changes, deposits.",
    apply: () => ({ type: "contract_event", events: SAFE_EVENTS.join("\n"), name: "Safe activity" }),
  },
  {
    id: "approvals",
    icon: "🔓",
    title: "Token approvals",
    who: "Security",
    desc: "Alert when your wallet approves any contract to spend its tokens.",
    apply: (me) => ({
      type: "contract_event",
      contract: "",
      events: "event Approval(address indexed owner, address indexed spender, uint256 value)",
      filters: me ? `owner=${me.user.address}` : "owner=",
      name: "My token approvals",
    }),
  },
  {
    id: "name",
    icon: "🪪",
    title: "Watch my .qie name",
    who: "Security",
    desc: "Alert if your QIE ID starts pointing to a different address.",
    apply: (me) => ({ type: "name_watch", watchName: me?.user.qieName ?? "", name: "My QIE ID" }),
  },
  {
    id: "whale",
    icon: "🐋",
    title: "QUSDC whale moves",
    who: "Community",
    desc: "Every QUSDC transfer of 1,000 or more.",
    apply: () => ({ type: "token_transfer", token: "QUSDC", minAmount: "1000", from: "", to: "", name: "QUSDC whales" }),
  },
  {
    id: "pairs",
    icon: "🆕",
    title: "New QIEDEX pairs",
    who: "Traders",
    desc: "Every new trading pair created on the official QIEDEX factory.",
    apply: () => ({
      type: "contract_event",
      contract: QIEDEX_FACTORY,
      events: "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 index)",
      filters: "",
      name: "New QIEDEX pairs",
    }),
  },
  {
    id: "price",
    icon: "📈",
    title: "WQIE price alert",
    who: "Traders",
    desc: "Alert when QIE's QIEDEX price crosses a level.",
    apply: () => ({ type: "price", priceToken: "WQIE", priceDir: "above", name: "WQIE price" }),
  },
];
