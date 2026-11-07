import { lazy, useMemo } from 'react';
import { MissionController } from './controller';
import { Screen, type WorldView } from './Screen';

const worldModules = import.meta.glob('../world/{index,World}.{ts,tsx}');
const worldEntry = ['../world/index.tsx', '../world/index.ts', '../world/World.tsx'].find((path) => path in worldModules);
const World = worldEntry
  ? lazy(async () => {
      const mod = (await worldModules[worldEntry]!()) as { World?: WorldView; default?: WorldView };
      return { default: (mod.World ?? mod.default)! };
    })
  : null;

export function Stage() {
  const controller = useMemo(() => new MissionController(), []);
  return <Screen controller={controller} World={World} switchTo={{ href: '#/lead', label: 'Use real phones' }} />;
}

export default Stage;
