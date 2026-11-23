# TOA Draw

A real-time multiplayer draw-and-guess party game. One player draws a word, everyone else races to guess it in chat. Faster guesses score more points.

## Why it exists

A lightweight team game for remote socials and onboarding sessions. Runs as a single Node.js service, so it deploys to Render's free tier with no database.

## Features

- Private rooms with a 5-character code and a shareable invite link (`/?r=CODE`).
- Quick play: matches players into public rooms, which auto-start once two people are in.
- Host controls: rounds, drawers per round, draw time, max players (up to Unlimited), word choices, letter hints, custom word list (optionally custom-only), remove player.
- Drawers per round: "Everyone" (each player draws once per round) or a fixed number picked at random each round, so big rooms still finish. Players who have drawn the fewest times go first, so nobody draws twice before everyone has drawn once. The lobby shows the resulting game length, the chat announces each round's drawers, and the top bar shows "Turn X of Y".
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
- **Lobby mic check:** when a player enters a chaos lobby, the page asks for microphone permission and briefly starts speech recognition. This catches both a blocked microphone and a blocked speech service (for example Edge on a managed device) before the game starts. Each player gets a "Your mic check" panel with a "Check again" button. The player list shows MIC OK, NO MIC or NO VOICE for everyone, and the host sees who has not passed. Players who fail can still draw and chat, and can opt out of voice (below).
- **Mic opt-out (3-second penalty):** a player whose mic does not work can tick "My mic isn't working" (in the lobby mic check panel, or under the chat during the game). Their typed answers then count, but the server holds every answer they send for 3 seconds before judging it. The answer is scored as if it arrived 3 seconds later: lower time bonus, a later place in the guess order, and a later claim on TOA Amplify 2x slots. An answer that lands after the turn has ended does not count. The delay is enforced on the server, so it cannot be skipped from the browser. Everyone sees a TYPING +3s badge on opted-out players, and their messages carry a +3s tag. Players who keep their mic are unaffected.

### TOA Amplify turns

Chaos rooms also get TOA Amplify turns. If every guesser gets a drawing, the next drawing is a TOA Amplify turn: the first 3 correct guesses score 2x points. The drawer's points are not doubled. Amplify turns can chain: if everyone also gets the Amplify drawing, the next one is Amplify too. Players see an Amplify badge with the number of 2x slots left, a gold board border, chat announcements, and "2x" tags in the turn summary.

Requirements and caveats:

- Uses the browser's Web Speech API. Chrome is the tested browser. Edge has the API, but on managed (company) devices its online speech service is often blocked and it shows a "speech service refused to start" error. Firefox has no support. Players without voice can still draw and chat but cannot answer.
- Needs microphone permission and a secure page (HTTPS, or `localhost` when running locally). Render serves HTTPS.
- Chrome and Edge send the audio to their online speech service to turn it into text. Tell players before using it in a work setting.
- The server trusts the browser's transcript. A determined player could bypass the microphone with developer tools. It is a party game, not an exam.

## Christmas theme

The game ships with a Christmas "Holiday edition" look, switched on by default:

- Red, green and gold palette on an evergreen night background, in light and dark mode
- Falling snow behind the page (skipped for people who set their device to reduce motion), twinkling lights under the header, a Santa hat on the logo, candy-cane stripes on the main cards
- 44 holiday words (candy cane, reindeer, gingerbread house...). Every set of word choices includes at least one, unless the room uses custom words only.

One setting controls all of it: the `HOLIDAY_THEME` environment variable. Leave it unset or set it to `christmas` for the theme. Set it to `off` for the plain look and the normal word list. On Render, change it under the service's Environment tab (it is also in `render.yaml`) and redeploy.

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
