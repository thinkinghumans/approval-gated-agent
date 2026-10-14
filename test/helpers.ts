import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditLog } from '../kernel/audit.ts';
import { Kernel } from '../kernel/kernel.ts';
import { loadPolicy } from '../kernel/policy.ts';
import type { PolicyConfig } from '../kernel/policy.ts';
import { Store } from '../kernel/store.ts';
import type { Dataset } from '../kernel/types.ts';
import { DATASET_FILE, POLICY_FILE, demoClock } from '../demo/run.ts';

export const DANA = 'human:dana.ortiz@acme-fab.example.com';
export const SAM = 'human:sam.whitfield@acme-fab.example.com';
export const PRIYA = 'human:priya.raman@acme-fab.example.com';
export const LEO = 'human:leo.brandt@acme-fab.example.com';
export const AGENT = 'agent:invoice-exception';

export function dataset(): Dataset {
  return JSON.parse(readFileSync(DATASET_FILE, 'utf8')) as Dataset;
}

export function policyConfig(): PolicyConfig {
  return JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as PolicyConfig;
}

export function setup(overrides: { policy?: (p: PolicyConfig) => PolicyConfig; file?: string } = {}) {
  const clock = demoClock();
  const cfg = overrides.policy ? overrides.policy(policyConfig()) : policyConfig();
  const policy = loadPolicy(cfg);
  const store = Store.fromDataset(dataset());
  const audit = new AuditLog({ clock, ...(overrides.file ? { file: overrides.file } : {}) });
  const kernel = new Kernel({ store, audit, policy, clock });
  return { kernel, audit, policy, store };
}

export function tempDir(prefix = 'aga-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
