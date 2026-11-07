# Judge runbook

A first look takes about ninety seconds on one screen, and it needs no account and no backend.

## Run it

```bash
npm install
npm run dev
```

Open the address Vite prints, or use https://shafir-01.github.io/AfterLink/. You will see a festival map with four teams walking between tasks, the live links between them and an HQ tower. Four real devices and a headquarters worker run behind it.

## The path

1. Watch the map for a moment. Medics, Access, Facilities and Supply share one mission, and each pulse on a line is a real delivery between two devices.
2. Break the network. Click the HQ tower, which becomes "HQ down" with its last confirmed time. Drop a request on the map, such as first aid, and watch peers assign it and finish it with no coordinator.
3. Split the teams. Drag across a line to cut it, and the connection behind it is really closed. Tap a team to see through its eyes, where the map shows only what that device knows.
4. Request the contested resource from both islands. One side commits. The other is refused, and the refusal says which right it lacks and what it can do next.
5. Carry the update. Drag a courier to the other group. The signed packet crosses as QR frames that the receiving device decodes. Carry it again and nothing is applied twice.
6. Restore contact. Drag a cut line back together. A link that closed while HQ was down reads as waiting for HQ until you restart the tower, because reopening needs signalling.
7. See what happened. The debrief lists what was done while headquarters was blind, what was refused and why, what was kept as a policy conflict, and what remains unknown.
8. Verify the file yourself. From the debrief choose Verify this run, or drop an exported file on the Verify page. You can also run `npx tsx packages/proof/src/cli.ts mission.afterlink`. Change one byte of the file and the check fails at the exact step.

The same path works from the keyboard, and on a narrow screen the map becomes a list of teams, links, courier routes and the tower. Use real phones switches to separate devices.

## Inspect it

Every device frame has its own developer tools context. In it you can see its identity, its event log and its RTCPeerConnection states. After the split, connections to the other group are closed.

## With several real devices

Run the relay, then open the device page on each phone.

```bash
npm run relay
```

Set `VITE_RELAY_URL` to the relay address when building the web app for devices on another origin. Devices connect to each other over WebRTC and the relay acts only as signalling and observer.

Phone cameras need a secure context to scan QR codes, so over a local network use HTTPS or open the page on localhost. The solo stage does not need the camera path across the network.

## Optional services

Claude, ElevenLabs and n8n features require keys on the relay. Copy `.env.example` to `.env` and fill the keys you have. `GET /api/status` on the relay reports which services are configured and never returns a secret.

## If something does not connect

Peer to peer needs a path between devices. On a network that blocks it, use the solo stage, which connects four frames inside one browser, or carry updates by QR. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
