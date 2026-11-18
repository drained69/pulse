import { createWalletClient, custom, defineChain, getAddress, type EIP1193Provider } from "viem";

type Announced = { info: { rdns: string; name: string; icon: string }; provider: EIP1193Provider };

const announced: Announced[] = [];
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    const d = (e as CustomEvent<Announced>).detail;
    if (d && !announced.some((a) => a.info.rdns === d.info.rdns)) announced.push(d);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/**
 * Pick a wallet: QIE Wallet first (EIP-6963 rdns `me.qiewallet`, or `window.qie`),
 * then any other injected EVM wallet. QIE Wallet also reports isMetaMask=true,
 * so we never branch on that flag (per the QIE Wallet integration guide).
 */
export function findProvider(): { provider: EIP1193Provider; name: string } | null {
  const qie = announced.find((a) => a.info.rdns === "me.qiewallet");
  if (qie) return { provider: qie.provider, name: "QIE Wallet" };
  const w = window as unknown as { qie?: EIP1193Provider; ethereum?: EIP1193Provider };
  if (w.qie) return { provider: w.qie, name: "QIE Wallet" };
  if (announced[0]) return { provider: announced[0].provider, name: announced[0].info.name };
  if (w.ethereum) return { provider: w.ethereum, name: "Browser wallet" };
  return null;
}

export function qieChain(chainId: number, rpcUrl: string, explorerUrl: string) {
  return defineChain({
    id: chainId,
    name: chainId === 1990 ? "QIE Mainnet" : "QIE Testnet",
    nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "QIE Explorer", url: explorerUrl } },
  });
}

export async function connect(): Promise<{ address: `0x${string}`; provider: EIP1193Provider; walletName: string }> {
  const found = findProvider();
  if (!found) throw new Error("No wallet found. Install QIE Wallet from qiewallet.me, then reload this page.");
  const accounts = (await found.provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet did not share an account");
  return { address: getAddress(accounts[0]), provider: found.provider, walletName: found.name };
}

/** Make sure the wallet is on QIE. Chain ids are compared numerically (QIE Wallet returns lowercase hex). */
export async function ensureChain(provider: EIP1193Provider, chainId: number, rpcUrl: string, explorerUrl: string): Promise<void> {
  const current = Number.parseInt((await provider.request({ method: "eth_chainId" })) as string, 16);
  if (current === chainId) return;
  const hex = `0x${chainId.toString(16)}` as const;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hex, chainName: chainId === 1990 ? "QIE Mainnet" : "QIE Testnet", nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 }, rpcUrls: [rpcUrl], blockExplorerUrls: [explorerUrl] }],
    });
  }
}

export function walletClient(provider: EIP1193Provider, account: `0x${string}`, chainId: number, rpcUrl: string, explorerUrl: string) {
  return createWalletClient({ account, chain: qieChain(chainId, rpcUrl, explorerUrl), transport: custom(provider) });
}

export async function signMessage(provider: EIP1193Provider, address: `0x${string}`, message: string): Promise<`0x${string}`> {
  return (await provider.request({ method: "personal_sign", params: [message as `0x${string}`, address] })) as `0x${string}`;
}
