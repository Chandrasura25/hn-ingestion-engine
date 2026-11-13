import { config } from '../config.js';
import { PermanentSourceError } from '../domain/errors.js';
import type { SourceAdapter } from '../domain/types.js';
import { ChaosSource } from './chaos/source.js';
import { HackerNewsSource } from './hackernews/source.js';

export class SourceRegistry {
  private readonly byName = new Map<string, SourceAdapter>();

  constructor(adapters: SourceAdapter[]) {
    for (const a of adapters) this.byName.set(a.name, a);
  }

  get(name: string): SourceAdapter {
    const s = this.byName.get(name);
    if (!s) throw new PermanentSourceError(`unknown source "${name}"`);
    return s;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }
}

export function defaultSources(): SourceRegistry {
  const adapters: SourceAdapter[] = [new HackerNewsSource()];
  if (config.CHAOS_SOURCE_ENABLED) adapters.push(new ChaosSource({ itemCount: 500 }));
  return new SourceRegistry(adapters);
}
