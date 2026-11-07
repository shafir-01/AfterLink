# Experiments

The lab compares three ways of running the same mission under the same faults, so that the value of local authority and peer reconciliation is measured and not asserted.

## Method

Each experiment runs a deterministic scenario with a seed and a fault schedule on the in-memory network, which uses the same protocol, planner and authority code as the browser. The memory network can partition and heal groups and apply loss, duplication, delay and reordering. Seeds and fault schedules are varied independently.

### Systems compared

| System | Behaviour |
|---|---|
| Central dispatcher | Tasks are assigned and exclusive resources allocated only while the central service is reachable |
| Offline task board | Every client edits locally and merges later with last write wins |
| AfterLink | Local planners, delegated tokens, peer transport and causal reconciliation |

The baselines are not handicapped. The dispatcher works normally whenever it is reachable, and the board merges every edit it receives.

### Scenario families

- Connected operation with normal incident arrival
- Loss of the central service after peers have connected
- Two isolated groups and rejoining
- Loss, duplication, reordering and delay
- Disconnect during a token transfer
- Simultaneous claims on one exclusive token
- A stale observation behind an irreversible task
- A device restarting mid-partition
- QR ferry delivering unknown events, and delivering the same packet twice
- A forged event and a replayed packet

### Measures

Tasks completed per outage, priority satisfied, duplicate exclusive commitments, correctly refused allocations, conflicts preserved after merge, convergence after reconnection, and bytes exchanged during reconciliation.

## Reproduce

```bash
npm install
npm run lab
```

Raw output is written under `docs/results/`.

## Results

Results are published only from files in `docs/results/` and from test output. This page quotes none of them directly, so it cannot drift from the data. Read the raw files for numbers, seeds and fault schedules.

## What the numbers do not show

They cover the scenario families above on a simulated network with four teams. They do not measure radio behaviour, browser connection setup on a real campus network, or human reaction time. The properties tested are checked on finite runs and randomised cases, which is evidence and not a proof of correctness for every possible history.
