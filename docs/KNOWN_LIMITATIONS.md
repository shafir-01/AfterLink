# Known limitations

These are the boundaries AfterLink holds on purpose. Each one is a choice that keeps a claim honest, and each says what to do about it.

## What the protocol guarantees, and what it does not

AfterLink guarantees the digital rights. An exclusive token has one holder, a transfer is a locked handshake, and conservation of tokens is checked as an invariant. Events are signed, hash chained and idempotent, so a replayed or altered event is rejected.

It does not guarantee physical possession. A token says a team has the right to commit a chair. It cannot prove the chair is in their hands, so physical inventory stays a human observation recorded with its source and age.

It does not defend against a compromised device. A stolen or malicious device holds valid keys and can sign valid events until the organiser revokes it, and a device that is partitioned may not hear the revocation. Signatures prove who signed and not whether what they reported is true. Equivocation by a token holder is detected and surfaced after the fact, and this system does not prevent it in advance.

## Forks

A device that is restored from an old backup, or wiped and brought back with only stale peers reachable, has lost part of its own history. It can then sign a new event at a position it already used, and its log forks. AfterLink detects forks. Every peer compares chain heads, so two events at one position are surfaced as a violation in the debrief with both branches kept, and the organiser decides which stands.

## What a verified mission file proves

A file that verifies proves that every event in it is signed, chained, causally ordered and lawful, and that rights were conserved and committed once. It proves the events present, and it cannot prove that none were removed. The six word fingerprint names exactly the set of events in the file, so two people holding different subsets will see different words.

## Availability is spent to keep safety

If a transfer acknowledgement is lost, the token stays in transit and nobody uses it. That is the price of never double spending without a coordinator. The remedy is contact, a QR carry, or a human decision, and the refusal tells the requester which of these applies.

A team that holds no token for a resource cannot commit to work that needs it while partitioned from the holder. This is a refusal by design, and the requester is offered a transfer request, a wait, a substitute or an escalation.

## Network

WebRTC needs signalling to open a connection. Peers already connected keep talking when signalling dies, and peers that were never connected cannot start. Switching a device to airplane mode closes its channels, so a physically disconnected device is reachable only by QR until radios return.

Direct connections depend on the browser and the network. Default configuration uses public STUN. Some campus and corporate networks block peer to peer traffic, and a relay such as TURN is not bundled.

A QR frame holds a few kilobytes at best, so a ferry carries a delta of the events the receiver is missing, compressed and chunked into several frames. Large histories need more frames and more patience.

## Time

Wall clocks are display only. Ordering uses Lamport clocks and causal parents. Cover rules that use `coverAfterMs` rely on each device's own clock to judge how long a peer has been silent, so clock drift can make cover start earlier or later on one device than another. The consequence is bounded, because duplicate effort is a policy conflict and not a violation.

## Membership

The roster is fixed at provisioning for this scenario. Late joiners, key rotation and revocation lists are not part of the demonstrated protocol.

## Intelligence and external services

n8n and Claude are optional boundaries, and so is ElevenLabs. They need keys or a webhook configured on the relay. Without them the product reports the service as unconfigured through `GET /api/status` and the matching feature is off, while the mission, the map, the debrief and the verifier run unchanged.

Speech to text needs a connection and does not work offline. Briefings are playable offline only if they were synthesised and cached before the outage.

Model output is validated against the capsule schema and domain rules before it is used, and it never creates rights the issuer did not sign.

## Scale and scope

The demonstrated scenario has four teams and three scarce resources. Event logs are not compacted, so long missions grow without bound in this version. The lab tests 17 scenario families on a simulated network, and results should be read as covering those families only. Its own Known defects table lists the runs where AfterLink raised a violation or did not converge. See [EXPERIMENTS.md](EXPERIMENTS.md) and `results/SUMMARY.md`.

## Privacy

The scenario is synthetic and carries no personal data. QR packets contain mission events, so a real deployment should treat a printed or displayed packet as sensitive.
