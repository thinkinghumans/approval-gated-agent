// Identities are plain strings with a kind prefix:
//
//   human:dana.ortiz@acme-fab.example.com   a person, named in the policy directory
//   agent:invoice-exception                 software that reads and proposes
//   system:kernel                           the kernel itself (bookkeeping only)
//
// Only human identities can approve an action or appear as the actor of an
// executed action. The check is structural, so an agent cannot pass by
// choosing a clever name.

export type HumanId = `human:${string}`;
export type AgentId = `agent:${string}`;
export type SystemId = `system:${string}`;
export type Actor = HumanId | AgentId | SystemId;

const HUMAN_RE = /^human:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const AGENT_RE = /^agent:[a-z0-9][a-z0-9-]*$/;
const SYSTEM_RE = /^system:[a-z0-9][a-z0-9-]*$/;

export function isHumanId(value: unknown): value is HumanId {
  return typeof value === 'string' && HUMAN_RE.test(value);
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_RE.test(value);
}

export function isActor(value: unknown): value is Actor {
  return isHumanId(value) || isAgentId(value) || (typeof value === 'string' && SYSTEM_RE.test(value));
}

export class IdentityError extends Error {
  override name = 'IdentityError';
}

export function requireHuman(value: unknown, what: string): HumanId {
  if (!isHumanId(value)) {
    throw new IdentityError(`${what} requires a human identity (human:<email>); got ${JSON.stringify(value)}`);
  }
  return value;
}
