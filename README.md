# Red vs Blue — online

Play Red vs Blue with friends in the browser. One person creates a room and sends
the invite link; the other opens it and joins. Anyone else who opens the link can watch.
Moves show up for everyone within about a second.

## Deploy to Vercel (about 5 minutes)

1. **Put the project on GitHub.** Create a new repository and upload the contents of
   this folder, *or* skip GitHub and deploy from your computer with the Vercel CLI:
   `npm i -g vercel`, then run `vercel` inside this folder.
2. **Import it in Vercel.** On vercel.com, choose **Add New → Project**, pick the
   repository, and click **Deploy**. No settings need changing: the framework is
   "Other" and there is no build step.
3. **Add Redis.** In the project, open the **Storage** tab, choose **Create Database**,
   and pick a Redis provider (for example *Upstash for Redis*, which has a free plan).
   Connect it to this project. Vercel adds the connection settings as environment
   variables automatically.
4. **Redeploy.** Go to **Deployments**, open the ⋯ menu on the latest one, and click
   **Redeploy**, so the site picks up the new Redis settings.

Open your site, type your name, click **Create game**, then **Copy invite link**.

The server accepts any of these environment variables, so either kind of Redis works:

| Provider | Variables |
| --- | --- |
| Upstash (REST) | `KV_REST_API_URL` + `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` |
| Any Redis server (e.g. Redis Cloud) | `REDIS_URL` (or `KV_URL`) |

If none are set on Vercel, the game shows a message telling you to connect Redis.

## How it works

```
public/index.html   page layout and styles
public/app.js       the browser app: lobby, board, controls, talking to the server
public/rules.js     the game rules (shared by the browser and the server)
api/room.js         one serverless function: create/join rooms, seats, moves
lib/store.js        Redis storage (Upstash REST, a Redis URL, or in-memory for testing)
dev-server.js       runs everything on your own computer for testing
```

- **The server runs the same rules code as the browser.** It checks every move, so
  nobody can move the other player's stones, move out of turn, or make an illegal move.
- **Rooms are stored in Redis** under `rvb:room:<CODE>`, with a version number
  under `rvb:room:<CODE>:v`. Rooms expire 14 days after the last change.
- **Writes are compare-and-set.** If two people act at the same moment, neither
  change is lost. If a move was aimed at a board that changed in the meantime, the
  player is told to take another look.
- **Browsers poll for changes.** They check about once a second while waiting for the
  other player, every 2.5 seconds on their own turn, and every 6 seconds when the
  tab is in the background. Most checks read only the small version key.
- **Your seat is remembered in your browser,** so refreshing the page or coming
  back later keeps you in your seat. The person who created the room can free a seat
  (for example, if a friend switched devices).

### Redis usage

A one-hour game between two players uses roughly 5,000–6,000 Redis commands,
most of them tiny version checks. Compare that with your Redis plan's limits. To
poll less often, change the numbers in the last line of `poll()` in `public/app.js`
(1000 ms waiting / 2500 ms your turn / 6000 ms tab hidden).

## Game modes

Pick the mode under **Options → Game mode**. In an online room the mode is shared,
and switching it puts every point back.

- **Classic**: stones fight. When stones collide, the attacker loses if its blob is
  bigger than the defender's. Blue scores by leaving through the top wall and Red
  through the bottom wall.
- **Points**:
  - Stones never die, and can't move into walls or other stones.
  - Blue's points are the squares of the top row, and Red's are the bottom row.
  - A stone that lands on one of its own points picks it up. The stone turns lighter
    with a gold dot, and it can carry one point at a time.
  - The point scores when that stone reaches home. Blue's home is the bottom 5 rows
    and Red's is the top 5 rows.
  - Moving a blob drags everything stuck to it (any chain of touching stones, of
    either color). The move is only legal if nothing in the group would hit a wall
    or another stone.
  - Any move that puts a blue stone on a red point or a red stone on a blue point is
    illegal, whether the stone moves itself or is dragged. (Dragging an opponent's
    stone onto its *own* point is allowed, and it picks that point up.) Stones also
    can't be placed on the opponent's points, and if a resize, mode switch or loaded
    position would leave a stone on its opponent's point, that point is removed.

## Game features

Everything from the single-file version works in online rooms too, and everyone in
the room sees the result:

- Placing and removing stones
- Undo
- Switch turn, reset scores, clear board
- Board resizing
- The Blue 1 / 2 / 2 / 2 move order
- Options (turn enforcement, move order, how a lone attacking stone is sized)
- Copy/paste position codes

Board edits and option changes are written to the move log so both players can see
them. **Play on this device** in the menu is the offline pass-and-play mode. It saves
your game in the browser.

## Test on your own computer

```
npm install
npm run local        # http://localhost:3000
```

With no Redis variables set, rooms are kept in memory, so you can open two browser
windows (one of them private/incognito) and play against yourself. To use your real
database locally, run `vercel env pull .env.local`, then
`node --env-file=.env.local dev-server.js`.
