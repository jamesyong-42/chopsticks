import type { AgentRuntime } from './types.js';
import { createBuiltinProviders, type BuiltinProviderOptions } from './providers.js';
import { createAgentRuntime } from './runtime.js';
import type { AgentRuntimeOptions } from './types.js';

export interface BuiltinAgentRuntimeOptions extends Omit<AgentRuntimeOptions, 'providers'> {
  executables?: BuiltinProviderOptions['executables'];
}

/** Turn-key runtime containing every built-in provider behind one interface. */
export function createBuiltinAgentRuntime(options: BuiltinAgentRuntimeOptions): AgentRuntime {
  return createAgentRuntime({
    ...options,
    providers: createBuiltinProviders({ executables: options.executables }),
  });
}
