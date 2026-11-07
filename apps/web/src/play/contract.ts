import type { Json, TaskSource, TaskSpec, TeamId } from '@afterlink/protocol';
import type { ObserveOptions } from '../bridge';
import type { DebriefInput } from '../bridge/missionStore';
import type { StageController } from '../stage/contract';

/** What free play needs from the stage, on top of what the map uses. */
export interface PlayController extends StageController {
  /** Real addTask on that team's device. False while not live. */
  addTask(team: TeamId, spec: TaskSpec, source: TaskSource): boolean;
  /** Real observe on that team's device. False while not live. */
  observe(team: TeamId, key: string, value: Json, options?: ObserveOptions): boolean;
  /** Every device's own log and HQ record, merged: the exact input the debrief takes. */
  collect(): Promise<DebriefInput>;
}
