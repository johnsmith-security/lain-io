// App entry for the database layer (Expo / React Native).
import { createExpoPlatform } from './expoPlatform';
import { type LainDb, type LainDbConfig, getDb, initDb as initWithPlatform } from './index';

export * from './index';

let starting: Promise<LainDb> | null = null;

/** Initialise once at app start. Safe to call repeatedly. */
export function initDb(config?: Partial<LainDbConfig>): Promise<LainDb> {
  if (!starting) {
    starting = createExpoPlatform().then((platform) => initWithPlatform({ platform, config }));
    starting.catch(() => { starting = null; });
  }
  return starting;
}

export { getDb };
export * from './nativeMedia';
