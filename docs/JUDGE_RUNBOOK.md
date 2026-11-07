# Judge runbook

A first look takes about ninety seconds on one screen, and it needs no account and no backend.

## Run it

```bash
npm install
npm run dev
```

Open the address Vite prints. The stage loads four team devices and a headquarters observer on the same page.

## The path

1. Look at the stage. Four teams, Medics, Access, Facilities and Supply, share one mission. Each device shows its own next action.
2. Select Break the network. The headquarters worker is terminated, so the observer and signalling are gone. Send a new request from the stage and watch peers assign it and complete it with no coordinator.
3. Select Split. The mesh divides into two groups and each device closes its connections to the other side. Both groups still accept work, and each shows a different knowledge horizon.
4. Request the contested resource from both sides. One side commits. The other is refused, and the refusal says which right it lacks and what it can do next.
5. Select Carry update. A signed packet appears as QR frames on one device and is read by the other through its camera path. The receiving device gains the new information. Carry the same packet again and nothing is applied twice.
6. Select Restore contact. Signalling returns, links reopen and logs reconcile. The observer fills in the interval it could not see.
7. Open the debrief. It lists what was done while headquarters was blind, what was refused and why, what was kept as a policy conflict, and what remains unknown.

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
