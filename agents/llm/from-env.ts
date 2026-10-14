import { PlaybookPlanner } from '../invoice-exception/playbooks.ts';
import type { Planner } from '../planner.ts';
import { createAnthropicPlanner } from './anthropic.ts';
import { createOpenAICompatiblePlanner } from './openai-compatible.ts';

// Planner selection for the CLI. The playbook is the default and needs
// nothing. Model planners read their settings from the environment:
//
//   anthropic           ANTHROPIC_API_KEY (or another credential source the SDK
//                       recognizes), optional ANTHROPIC_MODEL
//   openai-compatible   OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_MODEL,
//                       optional OPENAI_COMPATIBLE_API_KEY

export const PLANNER_NAMES = ['playbook', 'anthropic', 'openai-compatible'] as const;
export type PlannerName = (typeof PLANNER_NAMES)[number];

export class PlannerConfigError extends Error {
  override name = 'PlannerConfigError';
}

export function plannerFromName(name: string, env: Record<string, string | undefined> = process.env): Planner {
  switch (name) {
    case 'playbook':
      return new PlaybookPlanner();
    case 'anthropic':
      return createAnthropicPlanner({
        ...(env.ANTHROPIC_MODEL ? { model: env.ANTHROPIC_MODEL } : {}),
        ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      });
    case 'openai-compatible': {
      const baseUrl = env.OPENAI_COMPATIBLE_BASE_URL;
      const model = env.OPENAI_COMPATIBLE_MODEL;
      if (!baseUrl || !model) {
        throw new PlannerConfigError('the openai-compatible planner needs OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_MODEL');
      }
      return createOpenAICompatiblePlanner({
        baseUrl,
        model,
        ...(env.OPENAI_COMPATIBLE_API_KEY ? { apiKey: env.OPENAI_COMPATIBLE_API_KEY } : {}),
      });
    }
    default:
      throw new PlannerConfigError(`unknown planner "${name}"; choose one of ${PLANNER_NAMES.join(', ')}`);
  }
}
