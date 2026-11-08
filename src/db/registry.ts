// Read-only lists published by the LainCorp release account (only that key
// can write its space):
//   ~release/models/<version>   JSON ModelRelease | null
//   ~release/relays/<id>        JSON RelayInfo | null

import { safeJson } from './encoding';
import { type Ctx, collectMap, subscribeMap, userNode } from './graph';
import type { ModelRelease, RelayInfo, Unsubscribe } from './types';

const isModel = (m: Partial<ModelRelease> | undefined): m is ModelRelease =>
  Boolean(m && m.version && /^https:\/\//.test(String(m.url)) && /^[0-9a-f]{64}$/i.test(String(m.sha256)) && Number(m.size) > 0);
const isRelay = (r: Partial<RelayInfo> | undefined): r is RelayInfo => Boolean(r && r.id && /^wss?:\/\//.test(String(r.url)));

export class Registry {
  constructor(private ctx: Ctx) {}
  private get release() { return this.ctx.config.releasePub; }

  async listModels(): Promise<ModelRelease[]> {
    if (!this.release) return [];
    const items = await collectMap(userNode(this.ctx, this.release).get('models'), { idleMs: 600, maxMs: this.ctx.config.readTimeoutMs });
    return [...items].map(([version, raw]) => safeJson<ModelRelease>(raw))
      .filter((m): m is ModelRelease => isModel(m))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  subscribeModels(cb: (models: ModelRelease[]) => void): Unsubscribe {
    if (!this.release) { cb([]); return () => {}; }
    const models = new Map<string, ModelRelease>();
    return subscribeMap(userNode(this.ctx, this.release).get('models'), (version, raw) => {
      const m = safeJson<ModelRelease>(raw);
      if (isModel(m) && m.version === version) models.set(version, m); else models.delete(version);
      cb([...models.values()].sort((a, b) => b.createdAt - a.createdAt));
    });
  }

  async listRelays(): Promise<RelayInfo[]> {
    if (!this.release) return [];
    const items = await collectMap(userNode(this.ctx, this.release).get('relays'), { idleMs: 600, maxMs: this.ctx.config.readTimeoutMs });
    return [...items.values()].map((raw) => safeJson<RelayInfo>(raw)).filter((r): r is RelayInfo => isRelay(r));
  }
}
