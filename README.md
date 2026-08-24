# intercom

> Push-to-talk group audio web app for company townhalls.

## Features

- **Push-to-talk** — hold anywhere on the screen (or hold `Space` on desktop) to speak; release to mute
- **Participant grid** — MS Teams–style dark grid showing all users by alias with speaking glow
- **Session guard** — only `tech-be-townhall-2k26` is accepted; wrong codes show a red error
- **Mobile-first** — designed for phones first, works on any browser
- **Pure WebRTC** — direct peer-to-peer audio between browsers, no relay, maximum clarity
- **Port 3001** — won't conflict with create-me on 3000

## Quick Start

### Docker (recommended)

```bash
docker compose up --build -d
```

The app will be available on **port 3001**. Host IPs are printed to the container log:

```
docker compose logs intercom
```

### Local Node.js

```bash
npm install
npm start
```

Requires Node.js ≥ 18.

## Usage

1. Open `http://<host-ip>:3001` on your phone or laptop
2. Enter your **alias** (e.g. "Alex W.") and the **session code**: `tech-be-townhall-2k26`
3. Tap **Join Session** — allow microphone access when prompted
4. You'll enter the session grid. Your mic starts **muted**.
5. **Hold anywhere** on the screen to speak; **release** to mute again
6. Active speakers glow in orange
7. Tap **Exit** to leave (the session stays alive for everyone else)

## Notes

- **Noise suppression is off** — push-to-talk means there's nothing to suppress. Your device's default mic processing is used.
- **Audio quality** — 48 kHz mono, echo cancellation on, for clear voice reproduction.
- **STUN only** — uses Google's free STUN server. For cross-internet use, add a TURN server in `public/app.js` under `RTC_CONFIG`.
- **One session** — only `tech-be-townhall-2k26` is valid. To change or add sessions, edit `VALID_SESSION` in `server/index.js`.

## Stack

- Node.js + Express — static file serving
- Socket.IO — WebRTC signaling + speaking-state relay
- WebRTC — direct browser-to-browser audio mesh
- Vanilla JS / CSS — no framework, mobile-first dark theme

## License

Private — internal use only.
