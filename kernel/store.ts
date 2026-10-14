import type {
  Case,
  Dataset,
  DraftMessage,
  Invoice,
  PurchaseOrder,
  Receipt,
  Supplier,
  Task,
} from './types.ts';
import { isHumanId } from './identity.ts';
import { roundCents } from './money.ts';

// In-memory record store. The kernel owns it; agents never receive a
// reference to it, only deep copies handed out through audited reads.
// Swap this for a database in a real deployment; the kernel's contract with
// the rest of the system does not change.

export class DatasetError extends Error {
  override name = 'DatasetError';
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Dataset rejected:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

export class Store {
  readonly companyName: string;
  readonly suppliers = new Map<string, Supplier>();
  readonly purchaseOrders = new Map<string, PurchaseOrder>();
  readonly receipts = new Map<string, Receipt>();
  readonly invoices = new Map<string, Invoice>();
  readonly cases = new Map<string, Case>();
  readonly outbox: DraftMessage[] = [];
  readonly tasks: Task[] = [];
  readonly #counters = new Map<string, number>();

  private constructor(companyName: string) {
    this.companyName = companyName;
  }

  static fromDataset(ds: Dataset): Store {
    const problems = validateDataset(ds);
    if (problems.length) throw new DatasetError(problems);
    const store = new Store(ds.company.name);
    for (const s of ds.suppliers) store.suppliers.set(s.id, structuredClone(s));
    for (const p of ds.purchaseOrders) store.purchaseOrders.set(p.id, structuredClone(p));
    for (const r of ds.receipts) store.receipts.set(r.id, structuredClone(r));
    for (const i of ds.invoices) {
      store.invoices.set(i.id, { ...structuredClone(i), memo: i.memo ?? null, status: 'open', holdReason: null });
    }
    return store;
  }

  nextId(prefix: string): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, '0')}`;
  }

  receiptsForPo(poId: string): Receipt[] {
    return [...this.receipts.values()].filter((r) => r.poId === poId);
  }

  invoicesForSupplier(supplierId: string): Invoice[] {
    return [...this.invoices.values()].filter((i) => i.supplierId === supplierId);
  }

  /** Plain-JSON view of current state, for writing next to the audit log. */
  snapshot(): Record<string, unknown> {
    return {
      company: this.companyName,
      invoices: [...this.invoices.values()],
      cases: [...this.cases.values()],
      outbox: this.outbox,
      tasks: this.tasks,
    };
  }
}

function validateDataset(ds: Dataset): string[] {
  const problems: string[] = [];
  if (ds?.company?.currency !== 'USD') problems.push('company.currency must be "USD"');
  const unique = (kind: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`duplicate ${kind} id ${id}`);
      seen.add(id);
    }
    return seen;
  };
  const supplierIds = unique('supplier', ds.suppliers.map((s) => s.id));
  const poIds = unique('purchase order', ds.purchaseOrders.map((p) => p.id));
  unique('receipt', ds.receipts.map((r) => r.id));
  unique('invoice', ds.invoices.map((i) => i.id));

  for (const p of ds.purchaseOrders) {
    if (!supplierIds.has(p.supplierId)) problems.push(`${p.id}: unknown supplier ${p.supplierId}`);
    if (!isHumanId(p.buyer)) problems.push(`${p.id}: buyer must be a human identity`);
    for (const l of p.lines) {
      if (!(l.qty > 0) || !(l.unitPriceUsd >= 0)) problems.push(`${p.id} line ${l.line}: qty and price must be positive`);
    }
  }
  for (const r of ds.receipts) {
    if (!poIds.has(r.poId)) problems.push(`${r.id}: unknown purchase order ${r.poId}`);
    if (!isHumanId(r.receivedBy)) problems.push(`${r.id}: receivedBy must be a human identity`);
  }
  for (const i of ds.invoices) {
    if (!supplierIds.has(i.supplierId)) problems.push(`${i.id}: unknown supplier ${i.supplierId}`);
    // A poId that does not resolve is allowed on purpose: screening reports it as MISSING_PO.
    const sum = roundCents(i.lines.reduce((s, l) => s + l.qty * l.unitPriceUsd, 0));
    if (Math.abs(sum - i.totalUsd) > 0.005) {
      problems.push(`${i.id}: totalUsd ${i.totalUsd} does not equal the sum of its lines (${sum})`);
    }
  }
  return problems;
}
