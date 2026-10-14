import type { ScreeningView } from '../../kernel/kernel.ts';
import type { ScreeningTolerances } from '../../kernel/policy.ts';
import type { Finding, Invoice } from '../../kernel/types.ts';
import { roundCents, usd } from '../../kernel/money.ts';

// Deterministic screening: compare each open invoice with its purchase order
// and goods receipts, and with the supplier's other invoices. Plain code, so
// the same data always produces the same findings, and every rule can be read
// and tested on its own.
//
// Order matters. A duplicate explains every other mismatch on the copy, and an
// invoice with no valid PO has nothing to compare prices or quantities with,
// so those two short-circuit. Price and quantity variances can co-occur.

export interface ScreenResult {
  invoiceId: string;
  findings: Finding[];
}

export function screenAll(view: ScreeningView, tol: ScreeningTolerances): ScreenResult[] {
  const ordered = [...view.invoices].sort(byArrival);
  const duplicates = new Set<string>();
  const results: ScreenResult[] = [];
  for (const inv of ordered) {
    if (inv.status !== 'open') continue;
    const findings = screenInvoice(inv, view, tol, duplicates);
    if (findings.some((f) => f.type === 'DUPLICATE_INVOICE')) duplicates.add(inv.id);
    results.push({ invoiceId: inv.id, findings });
  }
  return results;
}

function screenInvoice(inv: Invoice, view: ScreeningView, tol: ScreeningTolerances, knownDuplicates: Set<string>): Finding[] {
  const dup = findOriginal(inv, view, knownDuplicates);
  if (dup) return [dup];

  const po = inv.poId ? view.purchaseOrders.find((p) => p.id === inv.poId) : undefined;
  if (!po || po.supplierId !== inv.supplierId) {
    const detail = !inv.poId
      ? `Invoice ${inv.supplierInvoiceNo} carries no purchase order reference`
      : !po
        ? `Invoice ${inv.supplierInvoiceNo} references ${inv.poId}, which is not in the PO register`
        : `Invoice ${inv.supplierInvoiceNo} references ${inv.poId}, which belongs to a different supplier`;
    return [{
      type: 'MISSING_PO', detail, amountAtStakeUsd: inv.totalUsd, refs: [inv.id],
      facts: { referencedPo: inv.poId ?? 'none', invoiceTotalUsd: inv.totalUsd },
    }];
  }

  const findings: Finding[] = [];
  const receipts = view.receipts.filter((r) => r.poId === po.id);

  for (const line of inv.lines) {
    const poLine = po.lines.find((l) => l.sku === line.sku);
    if (!poLine) {
      findings.push({
        type: 'PRICE_VARIANCE',
        detail: `${line.sku} is billed but not on ${po.id}`,
        amountAtStakeUsd: roundCents(line.qty * line.unitPriceUsd),
        refs: [inv.id, po.id],
        facts: { sku: line.sku, qty: line.qty, invoiceUnitPriceUsd: line.unitPriceUsd, poUnitPriceUsd: 0 },
      });
      continue;
    }
    const ceiling = poLine.unitPriceUsd * (1 + tol.priceTolerancePct / 100);
    if (line.unitPriceUsd > ceiling + 1e-9) {
      const variance = roundCents((line.unitPriceUsd - poLine.unitPriceUsd) * line.qty);
      findings.push({
        type: 'PRICE_VARIANCE',
        detail: `${line.sku} billed at ${usd(line.unitPriceUsd)} against ${usd(poLine.unitPriceUsd)} on ${po.id}; ${line.qty.toLocaleString('en-US')} units, ${usd(variance)} over`,
        amountAtStakeUsd: variance,
        refs: [inv.id, po.id],
        facts: { sku: line.sku, qty: line.qty, invoiceUnitPriceUsd: line.unitPriceUsd, poUnitPriceUsd: poLine.unitPriceUsd },
      });
    }

    // Quantity: what was received, less what earlier invoices already billed.
    const received = receipts.flatMap((r) => r.lines).filter((l) => l.sku === line.sku).reduce((s, l) => s + l.qtyReceived, 0);
    const previouslyBilled = view.invoices
      .filter((o) => o.id !== inv.id && o.poId === po.id && !knownDuplicates.has(o.id) && o.status !== 'rejected_duplicate' && byArrival(o, inv) < 0)
      .flatMap((o) => o.lines)
      .filter((l) => l.sku === line.sku)
      .reduce((s, l) => s + l.qty, 0);
    const billable = Math.max(0, received - previouslyBilled);
    if (line.qty > billable * (1 + tol.qtyTolerancePct / 100)) {
      const over = line.qty - billable;
      const amount = roundCents(over * line.unitPriceUsd);
      findings.push({
        type: 'QTY_VARIANCE',
        detail: `${line.sku}: ${line.qty.toLocaleString('en-US')} billed, ${billable.toLocaleString('en-US')} received and not yet billed; ${over.toLocaleString('en-US')} units (${usd(amount)}) not supported by a receipt`,
        amountAtStakeUsd: amount,
        refs: [inv.id, po.id, ...receipts.map((r) => r.id)],
        facts: { sku: line.sku, billedQty: line.qty, receivedQty: received, previouslyBilledQty: previouslyBilled, unitPriceUsd: line.unitPriceUsd },
      });
    }
  }
  // Largest dollar exposure first; that becomes the case's primary type.
  return findings.sort((a, b) => b.amountAtStakeUsd - a.amountAtStakeUsd);
}

/** Matches "TC-20931", "TC20931", "tc-20931-R", "TC-20931 (copy)". */
export function normalizeInvoiceNo(no: string): string {
  return no
    .trim()
    .replace(/(?:[\s._/-]+|\s*\()(r|rev|revised|copy|dup|duplicate|updated|resend|resent)\d*\)?$/i, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function findOriginal(inv: Invoice, view: ScreeningView, knownDuplicates: Set<string>): Finding | null {
  const key = normalizeInvoiceNo(inv.supplierInvoiceNo);
  for (const other of [...view.invoices].sort(byArrival)) {
    if (other.id === inv.id || other.supplierId !== inv.supplierId) continue;
    if (byArrival(other, inv) >= 0) continue; // only an earlier arrival can be the original
    if (other.status === 'rejected_duplicate' || knownDuplicates.has(other.id)) continue;
    const sameNumber = normalizeInvoiceNo(other.supplierInvoiceNo) === key;
    const sameAmountAndDate = other.totalUsd === inv.totalUsd && other.invoiceDate === inv.invoiceDate;
    if (!sameNumber && !sameAmountAndDate) continue;
    const basis = sameNumber ? 'invoice_number' : 'amount_and_date';
    return {
      type: 'DUPLICATE_INVOICE',
      detail: sameNumber
        ? `Supplier invoice number ${inv.supplierInvoiceNo} matches ${other.supplierInvoiceNo} on ${other.id}, received ${other.receivedOn}`
        : `Same amount (${usd(inv.totalUsd)}) and invoice date (${inv.invoiceDate}) as ${other.id}, under a different number`,
      amountAtStakeUsd: inv.totalUsd,
      refs: [inv.id, other.id],
      facts: { originalInvoiceId: other.id, basis, originalSupplierInvoiceNo: other.supplierInvoiceNo, totalUsd: inv.totalUsd },
    };
  }
  return null;
}

function byArrival(a: Invoice, b: Invoice): number {
  return a.receivedOn === b.receivedOn ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.receivedOn < b.receivedOn ? -1 : 1;
}
