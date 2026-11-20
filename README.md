# TOA Draw

A real-time multiplayer draw-and-guess party game. One player draws a word, everyone else races to guess it in chat. Faster guesses score more points.

## Why it exists

A lightweight team game for remote socials and onboarding sessions. Runs as a single Node.js service, so it deploys to Render's free tier with no database.

## Features

- Private rooms with a 5-character code and a shareable invite link (`/?r=CODE`).
- Quick play: matches players into public rooms, which auto-start once two people are in.
- Host controls: rounds, draw time, max players, word choices, letter hints, custom word list (optionally custom-only), remove player.
- Drawing tools: 22 colours, 4 brush sizes, eraser, flood fill, undo (Ctrl+Z), clear. Works with mouse, touch and pen.
- Guessing: case- and punctuation-insensitive matching, "is close!" hints for near misses, letter reveals as time runs down.
- Players who guessed and the drawer keep chatting publicly. Any message containing the answer is shown only to players who know it.
- Chaos mode for private rooms: answers only count when spoken out loud (see below).
- Late joiners see the current drawing and get a turn in the current round.
- Host hand-over when the host leaves, turn skip when the drawer leaves, auto-reconnect on network blips.
- Responsive layout for desktop and phones, light and dark mode.

## Chaos mode

Turn on **Chaos mode** under "Create private room" (the host can also change it in the lobby). In a chaos room:

- Guessers press the mic button (or Ctrl+M) once. It keeps listening for the rest of the turn, and every phrase they say is checked as a guess.
- A spoken phrase counts if it contains the answer as whole words, so "is it a hot dog" and "hotdog" both match "hot dog". Wrong spoken guesses appear in chat with a VOICE tag.
- Typed chat still works, but typed answers never count, and typed messages containing the answer are not shown to anyone.
- Public rooms never use chaos mode.

Requirements and caveats:

- Uses the browser's Web Speech API. Chrome is the tested browser. Edge has the API, but on managed (company) devices its online speech service is often blocked and it shows a "speech service refused to start" error. Firefox has no support. Players without voice can still draw and chat but cannot answer.
- Needs microphone permission and a secure page (HTTPS, or `localhost` when running locally). Render serves HTTPS.
- Chrome and Edge send the audio to their online speech service to turn it into text. Tell players before using it in a work setting.
- The server trusts the browser's transcript. A determined player could bypass the microphone with developer tools. It is a party game, not an exam.

## Run locally

Requires Node.js 20 or later.

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test           # end-to-end socket tests
```

Open two browser windows to play against yourself. `PORT` is the only setting (Render sets it automatically). No secrets are needed.

## Deploy to Render

Option A: Blueprint (uses `render.yaml`)

1. Push this repo to GitHub or GitLab.
2. In Render, choose **New > Blueprint** and select the repo.
3. Approve the `toa-draw` web service. Render runs `npm ci --omit=dev` and `npm start`.

Option B: Manual web service

1. **New > Web Service**, connect the repo.
2. Runtime: Node. Build command: `npm ci --omit=dev`. Start command: `npm start`.
3. Health check path: `/healthz`.

Render supports WebSockets on web services, so no extra config is needed.

### Things to know

- **Keep it to one instance.** Rooms live in server memory. Scaling past one instance needs a shared adapter (for example `@socket.io/redis-adapter`) plus sticky sessions.
- **Restarts end games.** A deploy or restart clears all rooms. Clients reconnect automatically but land back on the home screen.
- **Free plan sleeps.** Free services spin down after about 15 minutes idle. The first visit after that takes up to a minute to wake. Use a paid instance for events.

## Project layout

```
server.js          Express + Socket.IO bootstrap, room registry, socket events
src/room.js        Game state machine: lobby > choosing > drawing > turn end > game over
src/words.js       Default word list
public/            Static client (HTML, CSS, vanilla JS canvas)
test/              node:test end-to-end tests using socket.io-client
render.yaml        Render Blueprint
```

## How the game flow works

1. The host starts the game (public rooms start automatically).
2. Each round, every player draws once in random order.
3. The drawer has 15 seconds to pick a word, otherwise one is picked for them.
4. Guessers earn 50 to 400 points based on time left, plus a bonus for guessing early. The drawer earns 60 points per correct guess.
5. The turn ends when time runs out or everyone has guessed.
6. After the last round, a podium shows the top three, then the room returns to the lobby.

The server is authoritative: it validates every draw operation, only accepts drawing from the current drawer, and never sends the word to players who have not guessed it.
