import { QPulseError, type QPulse } from "./client.ts";
import type { Invoice, InvoiceToken } from "./types.ts";

/**
 * Pay-per-request (HTTP 402) on QIE.
 *
 *   app.get("/api/forecast", paywall({ client: qp, id: "forecast", amount: "0.05" }), handler);
 *
 * A request without a payment gets `402 Payment Required` with a Q-Pulse payment link. The caller
 * (a person or an AI agent) pays it with any QIE wallet, then repeats the request with the header
 * `X-QPulse-Payment: <link id>`. The middleware checks that the link was made by this paywall for
 * this price and is paid, then uses it up: one payment buys exactly one request.
 */

export const PAYMENT_HEADER = "x-qpulse-payment";

export type PaywallOptions = {
  client: QPulse;
  /** A stable name for what is being sold. A link made for one paywall can't pay for another. */
  id: string;
  /** Price per request, as a decimal string: "0.05". */
  amount: string;
  token?: InvoiceToken;
  /** Shown on the checkout page. */
  description?: string;
  /** name.qie or address that receives the money. Defaults to the API key's account wallet. */
  recipient?: string;
  /** How long a payer has to pay. 5–60, default 15. */
  expiresInMinutes?: number;
};

export type PaywallResult =
  | { paid: true; invoice: Invoice }
  | { paid: false; status: 402; headers: Record<string, string>; body: PaymentRequired };

export type PaymentRequired = {
  error: "payment_required";
  message: string;
  payment: {
    id: string;
    url: string;
    amount: string;
    token: string;
    tokenAddress: string | null;
    recipient: string;
    chainId: number;
    expiresAt: number;
    status: Invoice["status"];
  };
  retry: { header: "X-QPulse-Payment"; value: string };
};

function required(inv: Invoice, why?: string): PaywallResult {
  const message =
    why ??
    `Pay ${inv.amount.formatted} ${inv.token.symbol} on QIE (chain ${inv.chainId}) at ${inv.url}, then repeat this request with the header X-QPulse-Payment: ${inv.id}`;
  return {
    paid: false,
    status: 402,
    headers: { "x-qpulse-payment-url": inv.url, link: `<${inv.url}>; rel="payment"`, "cache-control": "no-store" },
    body: {
      error: "payment_required",
      message,
      payment: {
        id: inv.id,
        url: inv.url,
        amount: inv.amount.formatted,
        token: inv.token.symbol,
        tokenAddress: inv.token.address,
        recipient: inv.recipient.address,
        chainId: inv.chainId,
        expiresAt: inv.expiresAt,
        status: inv.status,
      },
      retry: { header: "X-QPulse-Payment", value: inv.id },
    },
  };
}

/** Was this link made by this paywall, for this price? */
function belongsTo(inv: Invoice, opts: PaywallOptions): boolean {
  return inv.metadata?.paywall === opts.id && inv.baseAmount.formatted === Number(opts.amount).toString() && inv.token.symbol === (opts.token ?? "QUSDC");
}

/** Framework-neutral check: give it the value of the X-QPulse-Payment header (or undefined). */
export async function checkPayment(opts: PaywallOptions, paymentId: string | undefined): Promise<PaywallResult> {
  const fresh = async (why?: string) =>
    required(
      await opts.client.invoices.create({
        amount: opts.amount,
        token: opts.token ?? "QUSDC",
        description: opts.description ?? opts.id,
        recipient: opts.recipient,
        expiresInMinutes: opts.expiresInMinutes ?? 15,
        metadata: { paywall: opts.id },
      }),
      why,
    );
  const id = paymentId?.trim();
  if (!id || !/^inv_[0-9a-f]{8,40}$/.test(id)) return fresh();

  let inv: Invoice;
  try {
    inv = await opts.client.invoices.get(id);
  } catch (e) {
    if (e instanceof QPulseError && e.status === 404) return fresh("That payment link doesn't exist. Pay this one instead.");
    throw e;
  }
  if (!belongsTo(inv, opts)) return fresh("That payment link is for something else. Pay this one instead.");
  if (inv.status === "open") return required(inv, `Not paid yet. Pay ${inv.amount.formatted} ${inv.token.symbol} at ${inv.url}, then repeat the request.`);
  if (inv.status !== "paid") return fresh(`That payment link is ${inv.status}. Pay this one instead.`);
  try {
    return { paid: true, invoice: await opts.client.invoices.redeem(id) };
  } catch (e) {
    if (e instanceof QPulseError && e.status === 409) return fresh("That payment was already used for a request. Each payment buys one request.");
    throw e;
  }
}

type NodeReq = { headers: Record<string, string | string[] | undefined> };
type NodeRes = { statusCode: number; setHeader(name: string, value: string): unknown; end(body?: string): unknown };

/** Express / Connect / plain Node middleware. On success `req.qpulsePayment` holds the paid link. */
export function paywall(opts: PaywallOptions) {
  return async (req: NodeReq & { qpulsePayment?: Invoice }, res: NodeRes, next: (err?: unknown) => void): Promise<void> => {
    try {
      const raw = req.headers[PAYMENT_HEADER];
      const r = await checkPayment(opts, Array.isArray(raw) ? raw[0] : raw);
      if (r.paid) {
        req.qpulsePayment = r.invoice;
        return next();
      }
      res.statusCode = 402;
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      res.end(JSON.stringify(r.body));
    } catch (e) {
      next(e);
    }
  };
}
