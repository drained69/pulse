import { parseUnits } from "viem";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./hooks.ts";
import { INVOICE_TOKENS, type InvoiceService } from "./invoices.ts";
import { newId, nowSec } from "./util.ts";

/**
 * Products: reusable payment links. One permanent link (or a QR printed on a machine) per
 * product; every buyer who opens it gets a fresh one-time payment link with its own exact
 * amount, so payments are still matched without a memo. After paying, the buyer sees the
 * product's unlock content (a download link, licence key, door code…), and the merchant's
 * `invoice.paid` hooks fire with the product, which is how a device knows to unlock.
 */

export type ProductRow = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  amount: string;
  token: keyof typeof INVOICE_TOKENS;
  recipient: string;
  recipient_name: string | null;
  unlock_content: string | null;
  active: number;
  sold: number;
  last_sold_at: number | null;
  created_at: number;
};

export type ProductInput = {
  name?: unknown;
  description?: unknown;
  amount?: unknown;
  token?: unknown;
  recipient?: unknown;
  unlockContent?: unknown;
  active?: unknown;
};

const MAX_PRODUCTS = 50;
/** Checkout links a product may have open at once, so a flood of visits can't use up its amounts. */
const MAX_OPEN_PER_PRODUCT = 100;
/** How long a buyer has to pay once they open a product. */
const CHECKOUT_MINUTES = 15;

export class ProductService {
  private cfg: Config;
  private db: Db;
  private invoices: InvoiceService;

  constructor(cfg: Config, db: Db, invoices: InvoiceService) {
    this.cfg = cfg;
    this.db = db;
    this.invoices = invoices;
  }

  url(id: string): string {
    return `${this.cfg.publicUrl.replace(/\/$/, "")}/#/buy/${id}`;
  }

  /** What the merchant sees. */
  view(r: ProductRow) {
    const t = INVOICE_TOKENS[r.token];
    return {
      id: r.id,
      url: this.url(r.id),
      deviceUrl: `${this.cfg.publicUrl.replace(/\/$/, "")}/#/device/${r.id}`,
      name: r.name,
      description: r.description,
      price: { amount: r.amount, symbol: t.symbol, display: `${r.amount} ${t.symbol}` },
      recipient: { address: r.recipient, name: r.recipient_name },
      unlockContent: r.unlock_content,
      active: r.active === 1,
      sold: r.sold,
      lastSoldAt: r.last_sold_at,
      createdAt: r.created_at,
    };
  }

  /** What anyone with the link sees: never the unlock content. */
  publicView(r: ProductRow) {
    const v = this.view(r);
    return { id: v.id, url: v.url, name: v.name, description: v.description, price: v.price, recipient: v.recipient, active: v.active, lastSoldAt: v.lastSoldAt, chainId: this.cfg.chainId };
  }

  private validate(input: ProductInput, existing?: ProductRow) {
    if (!input || typeof input !== "object") throw new HttpError(400, "Body must be a JSON object");
    const name = String(input.name ?? existing?.name ?? "").trim();
    if (!name || name.length > 80) throw new HttpError(400, "name: 1–80 characters");
    const description = String(input.description ?? existing?.description ?? "").trim();
    if (description.length > 200) throw new HttpError(400, "description: at most 200 characters");
    const token = String(input.token ?? existing?.token ?? "QUSDC").toUpperCase() as ProductRow["token"];
    const t = INVOICE_TOKENS[token];
    if (!t) throw new HttpError(400, "token: QUSDC, QIE or WQIE");
    const amount = String(input.amount ?? existing?.amount ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(amount) || (amount.split(".")[1]?.length ?? 0) > 6) throw new HttpError(400, "amount: a positive number with at most 6 decimals, e.g. 2 or 0.5");
    const raw = parseUnits(amount, t.decimals);
    if (raw <= 0n || raw > parseUnits("1000000000", t.decimals)) throw new HttpError(400, "amount: must be between 0 and 1,000,000,000");
    const unlockRaw = input.unlockContent === undefined ? (existing?.unlock_content ?? null) : input.unlockContent;
    const unlock = unlockRaw === null || unlockRaw === "" ? null : String(unlockRaw).trim();
    if (unlock !== null && unlock.length > 2000) throw new HttpError(400, "unlockContent: at most 2,000 characters");
    const active = input.active === undefined ? (existing ? existing.active === 1 : true) : Boolean(input.active);
    return { name, description, token, amount, unlock, active };
  }

  async create(user: { id: string; address: string }, input: ProductInput) {
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM products WHERE user_id = ?").get(user.id) as { n: number }).n;
    if (n >= MAX_PRODUCTS) throw new HttpError(400, `At most ${MAX_PRODUCTS} products per account`);
    const v = this.validate(input);
    const recipient = await this.invoices.resolveRecipient(input.recipient, user.address);
    const row: ProductRow = {
      id: newId("prd", 8),
      user_id: user.id,
      name: v.name,
      description: v.description,
      amount: v.amount,
      token: v.token,
      recipient: recipient.address,
      recipient_name: recipient.name,
      unlock_content: v.unlock,
      active: v.active ? 1 : 0,
      sold: 0,
      last_sold_at: null,
      created_at: nowSec(),
    };
    this.db
      .prepare(
        `INSERT INTO products (id, user_id, name, description, amount, token, recipient, recipient_name, unlock_content, active, sold, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(row.id, row.user_id, row.name, row.description, row.amount, row.token, row.recipient, row.recipient_name, row.unlock_content, row.active, row.created_at);
    return this.view(row);
  }

  async update(user: { id: string; address: string }, id: string, input: ProductInput) {
    const r = this.row(user.id, id);
    const v = this.validate(input, r);
    const recipient = input.recipient === undefined ? { address: r.recipient, name: r.recipient_name } : await this.invoices.resolveRecipient(input.recipient, user.address);
    this.db
      .prepare("UPDATE products SET name=?, description=?, amount=?, token=?, recipient=?, recipient_name=?, unlock_content=?, active=? WHERE id=?")
      .run(v.name, v.description, v.amount, v.token, recipient.address, recipient.name, v.unlock, v.active ? 1 : 0, id);
    return this.get(user.id, id);
  }

  private row(userId: string, id: string): ProductRow {
    const r = this.db.prepare("SELECT * FROM products WHERE id = ? AND user_id = ?").get(id, userId) as ProductRow | undefined;
    if (!r) throw new HttpError(404, "Product not found");
    return r;
  }

  get(userId: string, id: string) {
    return this.view(this.row(userId, id));
  }

  list(userId: string) {
    return (this.db.prepare("SELECT * FROM products WHERE user_id = ? ORDER BY created_at DESC").all(userId) as ProductRow[]).map((r) => this.view(r));
  }

  remove(userId: string, id: string): void {
    this.row(userId, id);
    this.db.prepare("DELETE FROM products WHERE id = ?").run(id);
  }

  getPublic(id: string) {
    const r = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
    if (!r) throw new HttpError(404, "Product not found");
    return this.publicView(r);
  }

  /** Open a fresh one-time checkout for a buyer. */
  async buy(id: string) {
    const r = this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as ProductRow | undefined;
    if (!r) throw new HttpError(404, "Product not found");
    if (r.active !== 1) throw new HttpError(409, "This product is not on sale right now");
    const open = (
      this.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE product_id = ? AND status = 'open' AND expires_at > ?").get(id, nowSec()) as { n: number }
    ).n;
    if (open >= MAX_OPEN_PER_PRODUCT) throw new HttpError(429, "Lots of people are checking out right now. Try again in a few minutes.");
    const owner = this.db.prepare("SELECT id, address FROM users WHERE id = ?").get(r.user_id) as { id: string; address: string };
    return this.invoices.create(
      owner,
      {
        amount: r.amount,
        token: r.token,
        description: r.description ? `${r.name} · ${r.description}`.slice(0, 200) : r.name,
        recipient: r.recipient,
        expiresInMinutes: CHECKOUT_MINUTES,
        metadata: { productId: r.id },
      },
      { productId: r.id, recipientName: r.recipient_name },
    );
  }
}
