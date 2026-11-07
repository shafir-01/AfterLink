# Evidence

This page tells you what to look at to confirm that AfterLink is a working distributed system and not an animation. Each claim is paired with a way to check it yourself.

## Topology of the demo

Four field devices run as four same-origin frames, each with its own Ed25519 key, its own storage namespace, its own event log and its own RTCPeerConnections. A dedicated Web Worker plays HQ, acting as signalling hub and read-only observer, and reaches the devices by message port. The devices connect to each other with WebRTC DataChannels. With multiple physical devices the same device page runs on each phone and the HQ role runs in the relay service over WebSocket.

## Claims and how to check them

| Claim | What to look for | Automated check |
|---|---|---|
| Killing HQ does not stop the mission | After the HQ tower is killed, a new request is still assigned and completed by peers over open channels | Mesh and actor tests that stop the signalling hub and continue to exchange events |
| A partition really cuts links | Each device lists its link states, and blocked peers show as severed with no bytes counted | Mesh tests assert that severed links stop delivering |
| A scarce token is never promised twice | One side's request for the contested resource is refused with a stated reason, the other side commits | Authority tests and property tests on token conservation |
| A lost acknowledgement does not refund a token | The token shows as in transit to everyone and cannot be committed by the sender | Authority tests on the transfer lifecycle |
| A QR carry brings real information | The receiving device shows the new task or token after scanning, with no network involved | Ferry tests round-trip a packet through frames and decode |
| A repeated packet is a no-op | Scanning the same packet twice reports zero new events the second time | Protocol and ferry tests on idempotent ingest |
| Altered or forged events are rejected | A modified event fails signature verification | Protocol tests on verification |
| HQ shows honest knowledge | HQ shows last confirmed time for a device it cannot hear, and the debrief marks events it never saw | Reconcile tests on hidden interval accounting |
| Divergence is classified, not overwritten | The debrief lists policy conflicts with both records kept, and violations separately | Reconcile tests on classification |

## Where the raw evidence lives

- Test suites live next to each package under `packages/*` and run with `npm test`.
- Experiment output is written under `docs/results/` by `npm run lab`.
- Screenshots of intact operation, partition, local decisions, QR transfer and convergence are stored under `docs/screenshots/` when captured from the running product.

## Reading the results

Quote numbers only from the files in `docs/results/` and from test output. Every figure there states the scenario, seed and fault schedule that produced it. See [EXPERIMENTS.md](EXPERIMENTS.md) for the method and [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for what the evidence does not cover.

## Telling it apart from a staged run

Open the browser developer tools on any device frame and inspect its RTCPeerConnections. After the partition they are closed for blocked peers. Stop the network of the machine hosting the relay and the open channels continue. Reload one device mid-partition and it recovers its identity, log and tokens from its own storage, which a recording could not do.
