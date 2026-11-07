# AfterLink Continuity: fault lab results

Generated 2026-11-07T16:20:01.763Z by `npx tsx packages/lab/src/cli.ts --runs 200`. 17 scenario families, 200 seeded runs per family, 3 systems on each seed, 10200 runs in total. Node v24.14.1. 211 s of real time.

Every figure below is computed from `docs/results/results.json`. Replay any single run with `npx tsx packages/lab/src/cli.ts --replay <family>:<seed>:<system>`.

## What the data shows

- **Work during the outage.** Hub dead and peers split: AfterLink 15.5 [15.0, 16.0] tasks, central 2.7 [2.5, 3.0], board 16.1 [15.6, 16.6]. Priority-1: AfterLink 4.5 [4.2, 4.7], central 0.8 [0.6, 0.9], board 4.8 [4.5, 5.1].
- **AfterLink does not out-work the board.** Their intervals overlap on tasks done during that outage. What separates them is safety, not throughput.
- **When the hub survives.** With the hub alive on one side of a split, central did 10.3 [9.8, 10.8] tasks and AfterLink 14.5 [13.9, 15.0]. Connected, the three are 17.8 [17.3, 18.4], 17.3 [16.8, 17.8] and 17.8 [17.3, 18.3] (central, board, AfterLink): no system has a throughput edge when nothing is wrong.
- **Double-bookings.** Excluding the attack family: AfterLink 0 in 3200 runs, central 0, board 1532 (in 1158 of 3200 runs). A compromised custodian holding a valid key can still sign a double spend: see the attack table. AfterLink detects that, it does not prevent it.
- **False facts.** Irreversible work started on a fact that was false: AfterLink 0, central 0, board 204, all families.
- **Cost of being safe.** In the one-chair race AfterLink finished 4.3 [4.1, 4.6] priority-1 tasks in the outage against the board's 5.3 [5.1, 5.6], because it refused what the board double-booked. After a disconnect during a transfer the numbers are 5.4 [5.1, 5.7] and 6.9 [6.7, 7.2]. A right in transit stays locked for both sides until contact returns, by design.
- **Bandwidth.** AfterLink is the most expensive system on the wire. Connected, it sends 3688 kB per run against 487 kB for the board and 37 kB for central. After the hub-dead split it spends 766 kB to reconcile (420 kB of that backfilling the observer) against 89 kB and 15 kB.
- **Convergence.** Every AfterLink run converged.
- **Honest devices.** Outside the attack family, 9 AfterLink runs raised a violation against an honest device, and an independent replay of the rights ledger counted 9 spends by a non-holder. None became a double-booking. See Known defects below.
- **After a key is compromised.** A device that finds a fork under its own key stops signing, so 93 tasks it finished in the attack family never reached the record. That is the safe side of the trade, and it is a real loss of history for that device.

## How it was measured

All three systems face the same generated scenario for a seed: the same incidents at the same virtual times, the same hands-on durations, the same fault schedule. Four teams, one device each, one job at a time per team. Time is virtual: about 2 minutes connected, about 8 minutes of fault, 4 minutes to settle. One scoring function outside all three systems reads one field trace, so no system grades itself.

**AfterLink** is the real product: `ActorNode`, `Mesh`, anti-entropy, the planner, the token ledger and Ed25519-signed events, over `MemoryNetwork` in virtual time. Only the volunteer is simulated, tapping accept and done. Faults act on real links and signalling. Double-bookings are counted from the signed events by the lab, and rights are replayed by an independent ledger walk, not by the product's own checks.

**Central dispatcher** is written to be as strong as the design allows: durable ledger, immediate assignment, per-device work queues that keep people busy through an outage, retries over loss, and silent-owner reassignment under the same policy AfterLink uses. It stops assigning only when it cannot be reached. Teams that can reach the hub keep working normally during a split, and all resources sit in one pool with no transfers needed.

**Offline board (LWW)** works with no server. Each device edits locally, claims up to the same queue depth as AfterLink, pushes every write at once, gossips deltas over links with the same reconnection limits as the real mesh, follows the same cover rule, and has perfect clocks. It lacks only what makes it a last-write-wins board: no rights model, no validity on facts, no record of losing writes.

Choices that favour the baselines: board completions count even when the task used a double-booked item, a central worker gets credit for queued work finished during an outage, and wire attacks on both baselines are assumed stopped by authenticated channels rather than tested. A carried board export has nothing to verify, so forged and replayed packets are really applied to it.

Limits on what this shows: bytes are UTF-8 JSON sizes, in-memory links stand in for WebRTC, one device per team, the volunteer always does what the screen says, and the workload is synthetic. "Unsafe allocations refused" is the raw count of typed refusals and "confirmed" is the stricter count where ground truth shows the alternative was a real over-commitment or an action on a false fact. Refusals that simply asked a reachable holder for a transfer are not counted. The mandate family for AI, voice and n8n outages is not run, because no system here calls those services. Results describe this workload and these fault models, nothing wider.

## Where AfterLink lost

Generated from the data: every metric where AfterLink is worse than a baseline with non-overlapping 95% intervals. Metrics with no better or worse direction are left out.

| Metric | Against | Families |
|---|---|---|
| Bytes sent, whole run | Central dispatcher | all |
| Bytes sent, whole run | Offline board (LWW) | all |
| Tasks finished by two teams | Central dispatcher | two-groups, hub-death-split, exclusive-race, ferry-twice |
| Tasks finished by two teams | Offline board (LWW) | asymmetric |
| Time from heal to convergence | Central dispatcher | loss, reorder, retry-storm, transfer-disconnect |
| Time from heal to convergence | Offline board (LWW) | two-groups, hub-death-split, asymmetric, loss, reorder, retry-storm, transfer-disconnect, exclusive-race, stale-observation, restart-mid-partition, ferry-twice, incompatible-deps, forged-replay, membership-churn |
| Bytes sent from heal to convergence | Central dispatcher | two-groups, hub-death-split, loss, reorder, retry-storm, transfer-disconnect, exclusive-race, stale-observation, restart-mid-partition, ferry-twice, incompatible-deps, forged-replay, membership-churn |
| Bytes sent from heal to convergence | Offline board (LWW) | two-groups, hub-death-split, asymmetric, loss, reorder, retry-storm, transfer-disconnect, exclusive-race, stale-observation, restart-mid-partition, ferry-twice, incompatible-deps, forged-replay, membership-churn |
| Tasks completed during outage | Offline board (LWW) | transfer-disconnect, exclusive-race, stale-observation, incompatible-deps |
| Priority-1 tasks completed during outage | Offline board (LWW) | transfer-disconnect, exclusive-race, stale-observation |
| Tasks completed, whole run | Offline board (LWW) | forged-replay |
| Exclusive double-bookings | Central dispatcher | forged-replay |
| Invariant violations, total | Central dispatcher | forged-replay |
| Finished tasks missing from the merged record | Central dispatcher | forged-replay |
| Finished tasks missing from the merged record | Offline board (LWW) | forged-replay |
| Resource conservation breaches | Central dispatcher | forged-replay |
| Resource conservation breaches | Offline board (LWW) | forged-replay |

Figures for each are in the family tables below.

## Known defects

Everything AfterLink itself flagged as a violation, and every run that did not converge. In `forged-replay` violations are the expected result of the attack. Anywhere else they are defects in the product.

| Family | What | Runs | Replay |
|---|---|---|---|
| ferry-twice | token-fork | 2 of 200 | `--replay ferry-twice:1179:afterlink` |
| forged-replay | token-fork | 196 of 200 | `--replay forged-replay:1000:afterlink` |
| forged-replay | unauthorised-action | 13 of 200 | `--replay forged-replay:1016:afterlink` |
| incompatible-deps | token-fork | 1 of 200 | `--replay incompatible-deps:1122:afterlink` |
| restart-mid-partition | token-fork | 1 of 200 | `--replay restart-mid-partition:1178:afterlink` |
| stale-observation | token-fork | 3 of 200 | `--replay stale-observation:1014:afterlink` |
| transfer-disconnect | token-fork | 2 of 200 | `--replay transfer-disconnect:1018:afterlink` |

## Results by family

Cells are mean [95% interval]. Rates are shown with a Wilson interval. A count that is zero in every run shows the 95% upper bound on how often it could occur. "none in k of n" means k runs had no value (for example, no decision before the window closed), and those runs are excluded from the mean, not counted as zero.

### Connected operation (control) (`connected`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 17.84 [17.32, 18.37] | 17.27 [16.76, 17.78] | 17.80 [17.26, 18.33] |
| Priority-1 tasks completed during outage | 5.27 [4.99, 5.55] | 5.20 [4.92, 5.47] | 5.17 [4.89, 5.45] |
| Priority-1 tasks reported during outage | 6.03 [5.71, 6.34] | 6.03 [5.71, 6.34] | 6.03 [5.71, 6.34] |
| Tasks reported, whole run | 24.50 [23.76, 25.24] | 24.50 [23.76, 25.24] | 24.50 [23.76, 25.24] |
| Tasks completed, whole run | 23.00 [22.32, 23.68] | 22.98 [22.31, 23.66] | 22.98 [22.31, 23.65] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 2.8 s [2.6 s, 3.0 s] | 3.6 s [3.3 s, 3.8 s] | 2.8 s [2.6 s, 2.9 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.04 [0.00, 0.09] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.04 [0.00, 0.09] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.49 [1.28, 1.69] | 1.46 [1.25, 1.67] | 1.55 [1.34, 1.76] |
| Refusals ground truth confirms | 1.49 [1.28, 1.69] | 1.46 [1.25, 1.67] | 1.49 [1.28, 1.69] |
| Tasks finished by two teams | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Bytes sent, whole run | 37.0 kB [36.3 kB, 37.6 kB] | 486.9 kB [474.8 kB, 499.1 kB] | 3.69 MB [3.64 MB, 3.73 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.01] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.46 [0.18, 0.73] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Central service dies after peers connect (`hub-death`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 2.74 [2.50, 2.98] | 17.40 [16.89, 17.91] | 17.80 [17.28, 18.31] |
| Priority-1 tasks completed during outage | 0.72 [0.60, 0.84] | 5.16 [4.91, 5.40] | 5.12 [4.87, 5.37] |
| Priority-1 tasks reported during outage | 6.01 [5.69, 6.34] | 6.01 [5.69, 6.34] | 6.01 [5.69, 6.34] |
| Tasks reported, whole run | 24.68 [23.95, 25.40] | 24.68 [23.95, 25.40] | 24.68 [23.95, 25.40] |
| Tasks completed, whole run | 15.64 [15.24, 16.04] | 23.13 [22.47, 23.78] | 23.09 [22.42, 23.75] |
| Runs with a decision before the window closed | 0.0% (0/200) [0.0%, 1.9%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | none in 200 of 200 runs | 3.8 s [3.4 s, 4.2 s] | 3.0 s [2.7 s, 3.2 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.06 [0.01, 0.11] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.06 [0.01, 0.11] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.52 [1.31, 1.74] | 1.50 [1.29, 1.71] | 1.61 [1.39, 1.83] |
| Refusals ground truth confirms | 1.52 [1.31, 1.74] | 1.50 [1.29, 1.71] | 1.53 [1.32, 1.74] |
| Tasks finished by two teams | 0.03 [-0.00, 0.05] | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.5 s [0.5 s, 0.5 s] | 0.0 s [0.0 s, 0.0 s] | 0.0 s [0.0 s, 0.0 s] |
| Bytes sent from heal to convergence | 14.7 kB [14.2 kB, 15.2 kB] | 15 B [-14 B, 44 B] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Bytes sent, whole run | 26.3 kB [25.7 kB, 26.9 kB] | 488.5 kB [476.2 kB, 500.7 kB] | 3.65 MB [3.61 MB, 3.70 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.01] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.45 [0.16, 0.74] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Two isolated groups, hub stays with one, then rejoin (`two-groups`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 10.31 [9.83, 10.80] | 14.92 [14.38, 15.46] | 14.46 [13.94, 14.97] |
| Priority-1 tasks completed during outage | 3.29 [3.03, 3.54] | 4.71 [4.42, 5.00] | 4.39 [4.12, 4.66] |
| Priority-1 tasks reported during outage | 6.27 [5.96, 6.58] | 6.27 [5.96, 6.58] | 6.27 [5.96, 6.58] |
| Tasks reported, whole run | 24.07 [23.39, 24.76] | 24.07 [23.39, 24.76] | 24.07 [23.39, 24.76] |
| Tasks completed, whole run | 20.98 [20.44, 21.51] | 22.68 [22.08, 23.28] | 22.55 [21.95, 23.14] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 19 s [14 s, 25 s] | 9.1 s [7.3 s, 11 s] | 3.6 s [2.9 s, 4.2 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.68 [0.56, 0.80] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.68 [0.56, 0.80] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.22 [1.01, 1.43] | 1.11 [0.90, 1.32] | 2.69 [2.39, 2.98] |
| Refusals ground truth confirms | 1.22 [1.01, 1.43] | 0.98 [0.80, 1.16] | 1.25 [1.04, 1.47] |
| Tasks finished by two teams | 0.56 [0.46, 0.66] | 1.08 [0.92, 1.25] | 0.83 [0.69, 0.97] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.4 s [0.4 s, 0.4 s] | 0.2 s [0.2 s, 0.2 s] | 0.4 s [0.4 s, 0.5 s] |
| Bytes sent from heal to convergence | 6.4 kB [6.0 kB, 6.8 kB] | 83.2 kB [78.3 kB, 88.1 kB] | 627.1 kB [605.3 kB, 649.0 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 263.1 kB [252.1 kB, 274.2 kB] |
| Bytes sent, whole run | 32.7 kB [32.1 kB, 33.3 kB] | 426.6 kB [404.6 kB, 448.5 kB] | 2.85 MB [2.81 MB, 2.89 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.90 [1.70, 2.09] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.10 [1.77, 2.44] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Hub dies, then the peers split, then rejoin (`hub-death-split`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 2.74 [2.52, 2.96] | 16.11 [15.59, 16.64] | 15.49 [14.98, 16.01] |
| Priority-1 tasks completed during outage | 0.76 [0.64, 0.88] | 4.79 [4.52, 5.06] | 4.45 [4.19, 4.71] |
| Priority-1 tasks reported during outage | 6.03 [5.73, 6.33] | 6.03 [5.73, 6.33] | 6.03 [5.73, 6.33] |
| Tasks reported, whole run | 25.20 [24.46, 25.93] | 25.20 [24.46, 25.93] | 25.20 [24.46, 25.93] |
| Tasks completed, whole run | 15.93 [15.52, 16.33] | 23.68 [23.05, 24.32] | 23.54 [22.90, 24.17] |
| Runs with a decision before the window closed | 0.0% (0/200) [0.0%, 1.9%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | none in 200 of 200 runs | 3.7 s [3.3 s, 4.1 s] | 2.9 s [2.6 s, 3.2 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.67 [0.56, 0.78] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.67 [0.56, 0.78] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.44 [1.24, 1.63] | 1.35 [1.14, 1.56] | 2.97 [2.67, 3.27] |
| Refusals ground truth confirms | 1.44 [1.24, 1.63] | 1.17 [0.99, 1.35] | 1.46 [1.26, 1.66] |
| Tasks finished by two teams | 0.04 [0.01, 0.06] | 1.89 [1.66, 2.12] | 1.54 [1.34, 1.74] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.5 s [0.5 s, 0.5 s] | 0.2 s [0.2 s, 0.2 s] | 0.4 s [0.4 s, 0.4 s] |
| Bytes sent from heal to convergence | 15.2 kB [14.6 kB, 15.7 kB] | 89.4 kB [82.2 kB, 96.6 kB] | 766.1 kB [746.5 kB, 785.6 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 419.6 kB [410.0 kB, 429.2 kB] |
| Bytes sent, whole run | 27.1 kB [26.4 kB, 27.7 kB] | 445.3 kB [426.9 kB, 463.6 kB] | 3.02 MB [2.97 MB, 3.06 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.38 [2.15, 2.60] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.80 [2.46, 3.14] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Asymmetric partition with a bridge peer (`asymmetric`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 9.26 [8.84, 9.68] | 15.57 [15.08, 16.06] | 17.91 [17.45, 18.38] |
| Priority-1 tasks completed during outage | 2.85 [2.61, 3.08] | 4.86 [4.60, 5.12] | 5.30 [5.05, 5.55] |
| Priority-1 tasks reported during outage | 6.21 [5.87, 6.54] | 6.21 [5.87, 6.54] | 6.21 [5.87, 6.54] |
| Tasks reported, whole run | 25.31 [24.63, 25.99] | 25.31 [24.63, 25.99] | 25.31 [24.63, 25.99] |
| Tasks completed, whole run | 21.04 [20.49, 21.59] | 23.54 [22.96, 24.12] | 23.73 [23.13, 24.34] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 30 s [23 s, 37 s] | 3.7 s [3.3 s, 4.1 s] | 3.0 s [2.7 s, 3.3 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.06 [0.01, 0.10] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.06 [0.01, 0.10] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.53 [1.31, 1.76] | 1.79 [1.55, 2.04] | 2.56 [2.29, 2.83] |
| Refusals ground truth confirms | 1.53 [1.31, 1.76] | 1.51 [1.30, 1.73] | 1.53 [1.31, 1.76] |
| Tasks finished by two teams | 0.64 [0.52, 0.75] | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.02 [0.00, 0.04] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.5 s [0.4 s, 0.5 s] | 0.0 s [0.0 s, 0.0 s] | 0.0 s [0.0 s, 0.0 s] |
| Bytes sent from heal to convergence | 8.1 kB [7.7 kB, 8.4 kB] | 346 B [-332 B, 1.0 kB] | 11.7 kB [4.2 kB, 19.3 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 10.1 kB [3.6 kB, 16.5 kB] |
| Bytes sent, whole run | 32.8 kB [32.3 kB, 33.4 kB] | 590.3 kB [562.3 kB, 618.2 kB] | 4.45 MB [4.28 MB, 4.62 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.74 [1.48, 2.00] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.49 [0.24, 0.74] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Packet loss (`loss`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 18.13 [17.65, 18.60] | 17.52 [17.05, 18.00] | 18.04 [17.54, 18.54] |
| Priority-1 tasks completed during outage | 5.34 [5.08, 5.61] | 5.30 [5.04, 5.57] | 5.30 [5.04, 5.57] |
| Priority-1 tasks reported during outage | 6.22 [5.90, 6.54] | 6.22 [5.90, 6.54] | 6.22 [5.90, 6.54] |
| Tasks reported, whole run | 24.98 [24.28, 25.67] | 24.98 [24.28, 25.67] | 24.98 [24.28, 25.67] |
| Tasks completed, whole run | 23.34 [22.73, 23.96] | 23.36 [22.75, 23.97] | 23.34 [22.73, 23.95] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 2.9 s [2.7 s, 3.1 s] | 3.8 s [3.3 s, 4.3 s] | 3.3 s [2.9 s, 3.8 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.04 [0.01, 0.07] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.04 [0.01, 0.07] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.60 [1.38, 1.82] | 1.57 [1.36, 1.79] | 1.66 [1.43, 1.89] |
| Refusals ground truth confirms | 1.60 [1.38, 1.82] | 1.57 [1.36, 1.79] | 1.60 [1.38, 1.82] |
| Tasks finished by two teams | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.0 s [0.0 s, 0.0 s] | 0.0 s [0.0 s, 0.0 s] | 0.1 s [0.0 s, 0.1 s] |
| Bytes sent from heal to convergence | 5 B [-3 B, 13 B] | 17 B [-8 B, 43 B] | 1.8 kB [724 B, 2.8 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 354 B [112 B, 597 B] |
| Bytes sent, whole run | 45.7 kB [44.6 kB, 46.9 kB] | 547.3 kB [533.7 kB, 560.9 kB] | 3.88 MB [3.83 MB, 3.93 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.06 [0.02, 0.09] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.69 [0.46, 0.93] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Packet duplication (`duplication`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 17.64 [17.16, 18.11] | 17.16 [16.68, 17.64] | 17.57 [17.08, 18.07] |
| Priority-1 tasks completed during outage | 5.00 [4.73, 5.27] | 5.01 [4.74, 5.29] | 5.02 [4.74, 5.30] |
| Priority-1 tasks reported during outage | 5.79 [5.48, 6.10] | 5.79 [5.48, 6.10] | 5.79 [5.48, 6.10] |
| Tasks reported, whole run | 24.27 [23.59, 24.96] | 24.27 [23.59, 24.96] | 24.27 [23.59, 24.96] |
| Tasks completed, whole run | 22.82 [22.22, 23.41] | 22.82 [22.23, 23.41] | 22.81 [22.22, 23.40] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 2.9 s [2.7 s, 3.0 s] | 3.8 s [3.4 s, 4.2 s] | 2.9 s [2.7 s, 3.1 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.05 [0.01, 0.09] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.05 [0.01, 0.09] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.45 [1.22, 1.67] | 1.43 [1.20, 1.65] | 1.48 [1.26, 1.70] |
| Refusals ground truth confirms | 1.45 [1.22, 1.67] | 1.43 [1.20, 1.65] | 1.44 [1.22, 1.65] |
| Tasks finished by two teams | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.0 s [0.0 s, 0.0 s] | 0.0 s [0.0 s, 0.0 s] | 0.0 s [0.0 s, 0.0 s] |
| Bytes sent from heal to convergence | 0 B [-0 B, 0 B] | 22 B [-21 B, 66 B] | 92 B [-33 B, 217 B] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 36 B [-15 B, 87 B] |
| Bytes sent, whole run | 37.3 kB [36.8 kB, 37.9 kB] | 500.2 kB [489.3 kB, 511.0 kB] | 3.68 MB [3.64 MB, 3.72 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.38 [0.12, 0.63] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Packet reorder and delay (`reorder`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 17.73 [17.28, 18.19] | 17.51 [17.07, 17.95] | 17.73 [17.29, 18.18] |
| Priority-1 tasks completed during outage | 5.11 [4.86, 5.35] | 5.13 [4.88, 5.37] | 5.11 [4.87, 5.35] |
| Priority-1 tasks reported during outage | 5.96 [5.66, 6.26] | 5.96 [5.66, 6.26] | 5.96 [5.66, 6.26] |
| Tasks reported, whole run | 24.42 [23.74, 25.10] | 24.42 [23.74, 25.10] | 24.42 [23.74, 25.10] |
| Tasks completed, whole run | 22.94 [22.34, 23.54] | 23.14 [22.54, 23.74] | 22.93 [22.32, 23.53] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 4.3 s [4.1 s, 4.5 s] | 4.4 s [4.2 s, 4.7 s] | 4.0 s [3.7 s, 4.2 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.49 [0.37, 0.61] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.49 [0.37, 0.61] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.45 [1.21, 1.68] | 1.23 [1.00, 1.45] | 1.47 [1.23, 1.71] |
| Refusals ground truth confirms | 1.45 [1.21, 1.68] | 1.23 [1.00, 1.45] | 1.45 [1.21, 1.68] |
| Tasks finished by two teams | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.1 s [0.1 s, 0.1 s] | 0.1 s [0.0 s, 0.1 s] | 0.2 s [0.1 s, 0.2 s] |
| Bytes sent from heal to convergence | 98 B [64 B, 132 B] | 859 B [556 B, 1.2 kB] | 5.1 kB [3.6 kB, 6.6 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.7 kB [1.2 kB, 2.2 kB] |
| Bytes sent, whole run | 124.7 kB [117.4 kB, 131.9 kB] | 874.0 kB [836.6 kB, 911.4 kB] | 4.07 MB [4.02 MB, 4.13 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.47 [0.37, 0.57] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 12.28 [11.51, 13.05] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Loss, duplication, reorder and delay together (`retry-storm`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 17.78 [17.29, 18.27] | 17.54 [17.08, 17.99] | 17.84 [17.36, 18.32] |
| Priority-1 tasks completed during outage | 5.21 [4.96, 5.46] | 5.33 [5.07, 5.58] | 5.27 [5.02, 5.52] |
| Priority-1 tasks reported during outage | 5.99 [5.68, 6.30] | 5.99 [5.68, 6.30] | 5.99 [5.68, 6.30] |
| Tasks reported, whole run | 24.57 [23.90, 25.25] | 24.57 [23.90, 25.25] | 24.57 [23.90, 25.25] |
| Tasks completed, whole run | 23.12 [22.49, 23.75] | 23.32 [22.71, 23.93] | 23.11 [22.49, 23.73] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 5.1 s [4.9 s, 5.4 s] | 5.2 s [4.8 s, 5.6 s] | 4.9 s [4.5 s, 5.2 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.50 [0.40, 0.60] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.50 [0.40, 0.60] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.43 [1.19, 1.66] | 1.19 [0.96, 1.41] | 1.49 [1.26, 1.72] |
| Refusals ground truth confirms | 1.43 [1.19, 1.66] | 1.19 [0.96, 1.41] | 1.43 [1.19, 1.66] |
| Tasks finished by two teams | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.1 s [0.1 s, 0.1 s] | 0.1 s [0.1 s, 0.1 s] | 0.3 s [0.2 s, 0.4 s] |
| Bytes sent from heal to convergence | 187 B [136 B, 237 B] | 2.2 kB [1.5 kB, 2.8 kB] | 9.9 kB [7.3 kB, 12.5 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 3.3 kB [2.4 kB, 4.2 kB] |
| Bytes sent, whole run | 170.5 kB [160.0 kB, 180.9 kB] | 1.10 MB [1.05 MB, 1.16 MB] | 4.33 MB [4.26 MB, 4.40 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.65 [0.52, 0.77] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 13.24 [12.55, 13.94] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Disconnect during a resource-right transfer (`transfer-disconnect`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 15.28 [14.86, 15.69] | 17.91 [17.48, 18.34] | 16.55 [16.12, 16.98] |
| Priority-1 tasks completed during outage | 5.51 [5.27, 5.75] | 6.91 [6.66, 7.15] | 5.39 [5.14, 5.65] |
| Priority-1 tasks reported during outage | 8.10 [7.78, 8.42] | 8.10 [7.78, 8.42] | 8.10 [7.78, 8.42] |
| Tasks reported, whole run | 27.24 [26.56, 27.92] | 27.24 [26.56, 27.92] | 27.24 [26.56, 27.92] |
| Tasks completed, whole run | 24.87 [24.28, 25.46] | 26.39 [25.78, 26.99] | 25.47 [24.84, 26.10] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 4.2 s [3.8 s, 4.6 s] | 4.4 s [4.1 s, 4.8 s] | 2.8 s [2.6 s, 3.0 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.28 [1.20, 1.36] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.28 [1.20, 1.36] | 0.02 [-0.01, 0.05] |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.02] |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0.01 [-0.00, 0.02] |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.34 [1.25, 1.44] | 0.27 [0.18, 0.35] | 4.00 [3.79, 4.21] |
| Refusals ground truth confirms | 1.34 [1.25, 1.44] | 0.26 [0.17, 0.34] | 2.35 [2.25, 2.46] |
| Tasks finished by two teams | 0.61 [0.51, 0.72] | 0.96 [0.82, 1.10] | 0.82 [0.69, 0.96] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.4 s [0.3 s, 0.4 s] | 0.2 s [0.2 s, 0.2 s] | 0.5 s [0.4 s, 0.5 s] |
| Bytes sent from heal to convergence | 4.1 kB [3.9 kB, 4.4 kB] | 72.3 kB [68.5 kB, 76.1 kB] | 577.5 kB [561.9 kB, 593.0 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 212.9 kB [207.2 kB, 218.6 kB] |
| Bytes sent, whole run | 37.3 kB [36.7 kB, 37.8 kB] | 486.8 kB [471.2 kB, 502.4 kB] | 3.24 MB [3.20 MB, 3.27 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.95 [1.72, 2.17] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.02] |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.56 [2.28, 2.83] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Simultaneous claims on one exclusive item (`exclusive-race`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 2.84 [2.63, 3.05] | 14.56 [14.11, 15.01] | 13.13 [12.66, 13.60] |
| Priority-1 tasks completed during outage | 0.75 [0.63, 0.87] | 5.33 [5.07, 5.58] | 4.33 [4.07, 4.58] |
| Priority-1 tasks reported during outage | 8.19 [7.87, 8.50] | 8.19 [7.87, 8.50] | 8.19 [7.87, 8.50] |
| Tasks reported, whole run | 26.82 [26.11, 27.54] | 26.82 [26.11, 27.54] | 26.82 [26.11, 27.54] |
| Tasks completed, whole run | 15.87 [15.49, 16.24] | 24.91 [24.30, 25.52] | 24.07 [23.45, 24.68] |
| Runs with a decision before the window closed | 0.0% (0/200) [0.0%, 1.9%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | none in 200 of 200 runs | 14 s [12 s, 16 s] | 2.8 s [2.6 s, 2.9 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.35 [1.27, 1.44] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.35 [1.27, 1.44] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.35 [1.24, 1.46] | 0.24 [0.15, 0.33] | 2.01 [1.86, 2.16] |
| Refusals ground truth confirms | 1.35 [1.24, 1.46] | 0.23 [0.15, 0.32] | 1.36 [1.25, 1.47] |
| Tasks finished by two teams | 0.04 [0.00, 0.08] | 0.23 [0.17, 0.30] | 0.13 [0.08, 0.18] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.5 s [0.5 s, 0.5 s] | 0.2 s [0.2 s, 0.2 s] | 0.4 s [0.4 s, 0.5 s] |
| Bytes sent from heal to convergence | 16.4 kB [15.9 kB, 16.9 kB] | 121.9 kB [111.5 kB, 132.4 kB] | 905.5 kB [886.4 kB, 924.6 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 454.6 kB [445.1 kB, 464.1 kB] |
| Bytes sent, whole run | 28.0 kB [27.4 kB, 28.5 kB] | 631.5 kB [609.8 kB, 653.2 kB] | 2.99 MB [2.95 MB, 3.02 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.95 [1.77, 2.13] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.95 [1.66, 2.23] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Stale observation behind an irreversible task (`stale-observation`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 10.46 [10.11, 10.82] | 14.41 [13.98, 14.85] | 12.97 [12.53, 13.42] |
| Priority-1 tasks completed during outage | 3.15 [2.93, 3.36] | 4.21 [4.00, 4.43] | 3.21 [2.99, 3.42] |
| Priority-1 tasks reported during outage | 6.78 [6.46, 7.10] | 6.78 [6.46, 7.10] | 6.78 [6.46, 7.10] |
| Tasks reported, whole run | 27.79 [27.10, 28.47] | 27.79 [27.10, 28.47] | 27.79 [27.10, 28.47] |
| Tasks completed, whole run | 23.27 [22.79, 23.75] | 25.20 [24.65, 25.75] | 24.25 [23.69, 24.82] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 21 s [17 s, 25 s] | 17 s [14 s, 20 s] | 2.7 s [2.6 s, 2.9 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.34 [0.26, 0.42] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.36 [1.27, 1.45] | 0.03 [-0.00, 0.06] |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.02 [1.00, 1.04] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.03] |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0.01 [-0.00, 0.03] |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 3.50 [3.27, 3.72] | 1.40 [1.19, 1.61] | 3.37 [3.09, 3.64] |
| Refusals ground truth confirms | 3.50 [3.27, 3.72] | 1.40 [1.18, 1.61] | 2.50 [2.28, 2.73] |
| Tasks finished by two teams | 0.07 [0.03, 0.11] | 0.20 [0.14, 0.27] | 0.09 [0.05, 0.13] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.4 s [0.4 s, 0.5 s] | 0.2 s [0.2 s, 0.2 s] | 0.4 s [0.4 s, 0.4 s] |
| Bytes sent from heal to convergence | 8.1 kB [7.7 kB, 8.5 kB] | 129.3 kB [117.0 kB, 141.7 kB] | 786.0 kB [767.3 kB, 804.8 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 343.4 kB [335.4 kB, 351.5 kB] |
| Bytes sent, whole run | 34.6 kB [34.0 kB, 35.1 kB] | 669.5 kB [645.7 kB, 693.3 kB] | 3.02 MB [2.98 MB, 3.06 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.81 [1.64, 1.98] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.03] |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.06 [0.73, 1.40] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Device restart mid-partition (`restart-mid-partition`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 10.42 [9.94, 10.90] | 15.07 [14.58, 15.57] | 14.51 [14.01, 15.00] |
| Priority-1 tasks completed during outage | 3.19 [2.95, 3.44] | 4.53 [4.26, 4.80] | 4.19 [3.93, 4.45] |
| Priority-1 tasks reported during outage | 6.01 [5.69, 6.33] | 6.01 [5.69, 6.33] | 6.01 [5.69, 6.33] |
| Tasks reported, whole run | 24.75 [23.98, 25.52] | 24.75 [23.98, 25.52] | 24.75 [23.98, 25.52] |
| Tasks completed, whole run | 21.26 [20.68, 21.84] | 23.09 [22.42, 23.75] | 22.98 [22.31, 23.64] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 20 s [15 s, 25 s] | 7.4 s [5.8 s, 9.0 s] | 3.0 s [2.7 s, 3.3 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.65 [0.53, 0.77] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.65 [0.53, 0.77] | 0.01 [-0.01, 0.03] |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.01] |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0.01 [-0.00, 0.01] |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.43 [1.21, 1.65] | 1.43 [1.17, 1.69] | 3.19 [2.88, 3.51] |
| Refusals ground truth confirms | 1.43 [1.21, 1.65] | 1.23 [1.02, 1.44] | 1.47 [1.25, 1.69] |
| Tasks finished by two teams | 0.67 [0.54, 0.79] | 1.19 [1.02, 1.36] | 0.84 [0.71, 0.98] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.4 s [0.4 s, 0.4 s] | 0.2 s [0.2 s, 0.2 s] | 0.4 s [0.4 s, 0.4 s] |
| Bytes sent from heal to convergence | 6.5 kB [6.1 kB, 7.0 kB] | 102.6 kB [95.9 kB, 109.3 kB] | 663.0 kB [639.3 kB, 686.7 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 276.3 kB [264.8 kB, 287.7 kB] |
| Bytes sent, whole run | 33.3 kB [32.6 kB, 34.0 kB] | 450.8 kB [429.4 kB, 472.1 kB] | 2.88 MB [2.83 MB, 2.92 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.02 [1.80, 2.24] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.01] |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.06 [1.79, 2.34] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Records lost or re-issued by a restart | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### QR ferry across the gap, delivered twice (`ferry-twice`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 2.86 [2.61, 3.11] | 15.92 [15.41, 16.43] | 15.75 [15.23, 16.27] |
| Priority-1 tasks completed during outage | 0.86 [0.73, 0.99] | 4.76 [4.49, 5.03] | 4.64 [4.37, 4.91] |
| Priority-1 tasks reported during outage | 6.22 [5.89, 6.55] | 6.22 [5.89, 6.55] | 6.22 [5.89, 6.55] |
| Tasks reported, whole run | 25.75 [24.98, 26.52] | 25.75 [24.98, 26.52] | 25.75 [24.98, 26.52] |
| Tasks completed, whole run | 15.89 [15.52, 16.27] | 23.73 [23.07, 24.38] | 23.71 [23.05, 24.38] |
| Runs with a decision before the window closed | 0.0% (0/200) [0.0%, 1.9%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | none in 200 of 200 runs | 12 s [8.7 s, 15 s] | 3.1 s [2.7 s, 3.4 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.59 [0.48, 0.70] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.59 [0.48, 0.70] | 0.02 [-0.01, 0.05] |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.02] |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0.01 [-0.00, 0.02] |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.62 [1.38, 1.86] | 1.77 [1.51, 2.04] | 3.40 [3.09, 3.72] |
| Refusals ground truth confirms | 1.62 [1.38, 1.86] | 1.53 [1.30, 1.77] | 1.64 [1.40, 1.88] |
| Tasks finished by two teams | 0.02 [0.00, 0.04] | 1.68 [1.44, 1.91] | 1.20 [1.01, 1.38] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.5 s [0.5 s, 0.5 s] | 0.2 s [0.2 s, 0.2 s] | 0.5 s [0.4 s, 0.6 s] |
| Bytes sent from heal to convergence | 16.6 kB [16.0 kB, 17.2 kB] | 95.4 kB [89.5 kB, 101.3 kB] | 722.4 kB [702.3 kB, 742.5 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 422.0 kB [411.5 kB, 432.6 kB] |
| Bytes sent, whole run | 28.5 kB [27.8 kB, 29.2 kB] | 417.5 kB [399.7 kB, 435.4 kB] | 2.90 MB [2.85 MB, 2.94 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.98 [1.76, 2.19] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.02] |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.66 [2.32, 3.00] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Records applied from the first ferry copy | 3.73 [3.44, 4.03] | 6.89 [6.36, 7.43] | 22.56 [21.19, 23.93] |
| Records applied from the repeat ferry copy | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Competing assignments with incompatible dependencies (`incompatible-deps`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 10.70 [10.29, 11.10] | 14.81 [14.36, 15.27] | 13.59 [13.12, 14.06] |
| Priority-1 tasks completed during outage | 4.42 [4.18, 4.67] | 4.42 [4.17, 4.66] | 4.43 [4.18, 4.68] |
| Priority-1 tasks reported during outage | 7.08 [6.76, 7.39] | 7.08 [6.76, 7.39] | 7.08 [6.76, 7.39] |
| Tasks reported, whole run | 28.07 [27.38, 28.76] | 28.07 [27.38, 28.76] | 28.07 [27.38, 28.76] |
| Tasks completed, whole run | 23.61 [23.07, 24.16] | 25.23 [24.63, 25.83] | 24.93 [24.34, 25.53] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 6.4 s [5.7 s, 7.1 s] | 5.7 s [5.1 s, 6.2 s] | 2.8 s [2.6 s, 3.0 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.33 [0.25, 0.40] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.33 [0.25, 0.40] | 0.01 [-0.01, 0.03] |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.01] |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0.01 [-0.00, 0.01] |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.35 [1.25, 1.46] | 1.24 [1.15, 1.32] | 2.58 [2.40, 2.77] |
| Refusals ground truth confirms | 1.35 [1.25, 1.46] | 1.24 [1.15, 1.32] | 1.46 [1.35, 1.56] |
| Tasks finished by two teams | 0.12 [0.07, 0.17] | 0.18 [0.12, 0.25] | 0.12 [0.07, 0.16] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.5 s [0.4 s, 0.5 s] | 0.2 s [0.2 s, 0.2 s] | 0.5 s [0.4 s, 0.5 s] |
| Bytes sent from heal to convergence | 9.2 kB [8.9 kB, 9.5 kB] | 119.8 kB [110.2 kB, 129.4 kB] | 880.3 kB [862.4 kB, 898.1 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 384.2 kB [376.9 kB, 391.5 kB] |
| Bytes sent, whole run | 34.7 kB [34.1 kB, 35.3 kB] | 650.3 kB [628.8 kB, 671.7 kB] | 3.14 MB [3.11 MB, 3.18 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.83 [1.67, 2.00] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.01] |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.95 [0.65, 1.26] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

### Forged, tampered, replayed and insider events (`forged-replay`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 9.41 [9.05, 9.77] | 12.58 [12.13, 13.03] | 12.82 [12.32, 13.32] |
| Priority-1 tasks completed during outage | 3.33 [3.11, 3.56] | 3.30 [3.08, 3.52] | 3.61 [3.36, 3.86] |
| Priority-1 tasks reported during outage | 6.11 [5.78, 6.43] | 6.11 [5.78, 6.43] | 6.11 [5.78, 6.43] |
| Tasks reported, whole run | 24.77 [24.05, 25.50] | 24.77 [24.05, 25.50] | 24.77 [24.05, 25.50] |
| Tasks completed, whole run | 21.33 [20.81, 21.85] | 22.17 [21.56, 22.78] | 20.55 [19.94, 21.17] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 33 s [25 s, 40 s] | 24 s [19 s, 29 s] | 2.8 s [2.6 s, 3.0 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.15 [2.04, 2.25] | 1.05 [1.01, 1.10] |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 4.13 [4.02, 4.24] | 2.51 [2.42, 2.60] |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.47 [0.39, 0.54] |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.98 [0.96, 1.01] |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.99 [1.97, 2.00] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0.01 [-0.00, 0.01] |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.41 [1.19, 1.62] | 1.33 [1.13, 1.53] | 2.60 [2.35, 2.86] |
| Refusals ground truth confirms | 1.41 [1.19, 1.62] | 1.33 [1.13, 1.53] | 1.62 [1.39, 1.85] |
| Tasks finished by two teams | 0.07 [0.03, 0.10] | 0.17 [0.11, 0.22] | 0.12 [0.07, 0.16] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.4 s [0.4 s, 0.5 s] | 0.2 s [0.2 s, 0.2 s] | 0.4 s [0.4 s, 0.4 s] |
| Bytes sent from heal to convergence | 8.2 kB [7.8 kB, 8.5 kB] | 114.0 kB [104.6 kB, 123.4 kB] | 714.6 kB [694.4 kB, 734.8 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 310.1 kB [301.6 kB, 318.6 kB] |
| Bytes sent, whole run | 32.0 kB [31.4 kB, 32.6 kB] | 612.7 kB [589.4 kB, 636.0 kB] | 3.02 MB [2.98 MB, 3.05 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0.02 [0.00, 0.04] |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.77 [2.59, 2.96] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.23 [1.14, 1.32] |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 3.04 [2.68, 3.40] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 1.01 [1.00, 1.03] | 5.99 [5.98, 6.00] |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.98 [0.96, 1.00] |

### Repeated changes in peer membership (`membership-churn`)

| Metric | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Tasks completed during outage | 13.65 [13.20, 14.11] | 15.74 [15.31, 16.17] | 15.67 [15.21, 16.13] |
| Priority-1 tasks completed during outage | 4.42 [4.16, 4.67] | 5.01 [4.76, 5.27] | 4.87 [4.61, 5.13] |
| Priority-1 tasks reported during outage | 6.38 [6.02, 6.73] | 6.38 [6.02, 6.73] | 6.38 [6.02, 6.73] |
| Tasks reported, whole run | 25.14 [24.44, 25.85] | 25.14 [24.44, 25.85] | 25.14 [24.44, 25.85] |
| Tasks completed, whole run | 22.41 [21.87, 22.94] | 23.30 [22.70, 23.91] | 23.45 [22.84, 24.06] |
| Runs with a decision before the window closed | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time to first useful decision after the cut | 18 s [13 s, 22 s] | 7.9 s [5.9 s, 9.8 s] | 3.0 s [2.6 s, 3.4 s] |
| Exclusive double-bookings | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.53 [0.43, 0.63] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Invariant violations, total | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.54 [0.43, 0.64] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Irreversible work started on a false fact | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Work started before its dependency was done | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Finished tasks missing from the merged record | 0 in 200 runs, 95% upper bound 1.9% of runs | 0.01 [-0.00, 0.01] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Resource conservation breaches | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that changed state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Tokens spent by a non-holder (independent replay) | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Runs where replaying the record twice changed it | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Unsafe allocations refused | 1.43 [1.21, 1.64] | 1.73 [1.48, 1.98] | 3.56 [3.24, 3.88] |
| Refusals ground truth confirms | 1.43 [1.21, 1.64] | 1.39 [1.17, 1.60] | 1.50 [1.27, 1.72] |
| Tasks finished by two teams | 2.25 [2.00, 2.51] | 2.44 [2.20, 2.69] | 1.25 [1.09, 1.41] |
| Runs that converged | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] | 100.0% (200/200) [98.1%, 100.0%] |
| Time from heal to convergence | 0.4 s [0.4 s, 0.5 s] | 0.2 s [0.2 s, 0.2 s] | 0.4 s [0.4 s, 0.5 s] |
| Bytes sent from heal to convergence | 2.9 kB [2.7 kB, 3.2 kB] | 92.8 kB [86.2 kB, 99.4 kB] | 545.2 kB [522.0 kB, 568.5 kB] |
| Of which backfilling the observer | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 259.6 kB [248.5 kB, 270.7 kB] |
| Bytes sent, whole run | 35.4 kB [34.6 kB, 36.1 kB] | 445.8 kB [430.5 kB, 461.2 kB] | 3.11 MB [3.06 MB, 3.16 MB] |
| Rights still in transit at the end | none in 200 of 200 runs | none in 200 of 200 runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Conflicts surfaced after merge | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 2.62 [2.38, 2.86] |
| Conflicts left for a human | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Contested writes overwritten with no record | 0 in 200 runs, 95% upper bound 1.9% of runs | 4.47 [4.05, 4.90] | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks with no effect on state | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |
| Attacks that took effect and were surfaced | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs | 0 in 200 runs, 95% upper bound 1.9% of runs |

## Attack outcomes

Counts over all `forged-replay` runs. rejected: refused at the door. no-effect: taken in and changed nothing. detected: took effect and was surfaced as a violation. accepted: took effect silently. assumed: not exercised, because that baseline is given authenticated channels by assumption. not-applicable: the system has no such path.

| Attack | Central dispatcher | Offline board (LWW) | AfterLink |
|---|---|---|---|
| Event claiming a peer, signed by an outsider | assumed 200 | assumed 200 | rejected 200 |
| Real event with its body altered | assumed 200 | assumed 200 | rejected 198 |
| Well-signed event from a key not on the roster | assumed 200 | assumed 200 | rejected 200 |
| Old events sent again | assumed 200 | assumed 200 | rejected 200 |
| Carried packet with altered contents | not-applicable 200 | accepted 197, no-effect 3 | rejected 200 |
| Carried packet delivered again | not-applicable 200 | no-effect 200 | no-effect 200 |
| Compromised custodian signs two spends of one token | not-applicable 200 | accepted 200 | detected 196 |
