# Zappy

An entirely automatic game: autonomous AIs live on the world of **Minerth**,
eat to stay alive, gather stones and perform rituals to raise their level.
The first family to get six of its members to level 8 wins.

Three independent programs:

| Part | Language | What it does |
|---|---|---|
| `server/` | C (POSIX, `poll`) | the world, the rules and the timing — authoritative |
| `client/` | Python 3 | one autonomous player per process, no human input |
| `gui/` | Node + Canvas | a read-only view of the live world, no game engine |

---

## Build and run

```bash
make
```

Then, all in one go — server, graphic client and a squad of bots:

```bash
./scripts/play.sh 4242 6 100
```

and open <http://localhost:8080>.

### By hand

```bash
./zappy_server -p 4242 -x 15 -y 15 -n red blue -c 6 -t 100
```

```bash
./zappy_ai -n red -p 4242 -h localhost
```

```bash
./zappy_gui -p 4242 --http 8080
```

`./zappy_ai` and `./zappy_gui` are one-line wrappers around
`client/zappy_ai.py` and `gui/zappy_gui.js`.

### Options

```
./zappy_server -p <port> -x <width> -y <height> -n <team> [<team>] ... -c <nb> [-t <t>]
    -p  port number
    -x  width of the world
    -y  height of the world
    -n  names of the teams
    -c  number of authorized clients per team
    -t  time unit divider (default 100; the greater t is, the faster the game)

  bonus:
    --log          narrate every event on stderr
    --seed <n>     reproducible world generation
    --density <f>  resource density multiplier (default 1.0)
```

```
./zappy_ai -n <team> -p <port> [-h <hostname>]
  bonus: -v (narrate), -s <seed>, --max-spawn <n>, --no-spawn
```

```
./zappy_gui -p <port> [-h <host>] [--http <port>]
```

---

## Tests

```bash
make test
```

| Suite | What it covers |
|---|---|
| `tests/test_protocol.py` | the wire format of every command, the timing, the 10-command back pressure, the toroidal world, sound directions (against an independent reference), the rituals, death, rude clients, and the graphic protocol |
| `tests/test_ai.py` | the bot's own logic, the answer-queue discipline, and the time unit it measures |
| `tests/test_victory.py` | a whole game: six scripted clients driven from level 1 to level 8, ending on the server announcing the winner |

The server also builds clean under AddressSanitizer and UndefinedBehaviour­Sanitizer:

```bash
make -C server debug && make test
```

`scripts/simulate.sh 120 8 300` plays a headless game and reports how far
the bots got — the quickest way to see whether a change helped or hurt.
`scripts/inspect_logs.sh <dir>` and `scripts/show_starved.sh <dir>` dig into
the logs it leaves behind.

---

## How it works

### The server

A single-threaded, non-blocking `poll()` loop. Nothing can make it hang:
sockets are non-blocking, a client that never sends a newline is cut off
before it can exhaust memory, and a long action only ever delays the player
who asked for it. `poll()` sleeps exactly until the next thing is due — the
end of an action, a ship arriving, a ritual finishing, a player starving —
so an idle server costs nothing.

Each player owns a ring of at most **10** queued commands. The first one
starts, its finish time is `now + base/t`, and its effect is applied when
that moment arrives — so the answer reflects the world as it is *then*, not
as it was when the command was sent. Commands beyond the tenth are dropped.

### The world

Toroidal: `wrap_x` and `wrap_y` are applied to every coordinate, so leaving
by one edge comes back in on the other. Sound, vision and movement all use
the same wrapping.

**Resource generation rules** (`server/src/world.c`):

* at most one food per square;
* at most one stone of a given type per square;
* at most three different stone *types* per square;
* quantities follow a density per resource, decreasing with rarity — food
  0.5, jade 0.3, peridot 0.15, amber 0.1, amethyst 0.1, garnet 0.08,
  ammolite 0.05 per square, all scaled by `--density`.

These rules constrain what the *server* creates; players may stack whatever
they like by dropping objects.

Resources grow back every 20 time units, up to those same quantities.
Without it the map is mined out long before anyone reaches level 8 and the
game becomes unwinnable — the subject does not mention it, so it is called
out here.

### Vision

A level `L` player sees `L + 1` rows, row `k` holding `2k + 1` squares,
listed from his left to his right, relative to the way he faces.

### Sound

`1` is the square in front of the player, and the numbering runs
counter-clockwise around him. The direction is computed from the *shortest*
path across the torus, quantised to the eight neighbours, then rotated into
the listener's frame. `tests/test_protocol.py` cross-checks every direction
against an independently written reference, for all four facings.

### The ritual

The table of stones and player counts is the subject's, unchanged. Anyone
of the right level standing on the square takes part. Two details the
subject leaves open, both learned the hard way from watching bots die:

* **The stones are used up when the ritual starts**, not when it ends.
  Left on the ground for 300 time units they were simply picked up by a
  passer-by, and a gathering everybody had walked across the map for failed
  every single time.
* **Only the player who called the ritual is held** for its 300 time units —
  that is just how long his `enchantment` command takes. The others keep
  their freedom. Holding a bystander still because somebody *else* started
  chanting stops him eating, and made it possible to starve a rival simply
  by performing rituals next to him.

When it ends, whoever is still on the square at the right level goes up a
level. If a participant dies or walks off, the others carry on; if only one
is left and the level needed more, the ritual breaks down and its caller
gets `ko`.

### The bots

Each client is one process, and the only thing they ever tell each other is
an in-game `broadcast`:

```
Z <team> rally <level> <token>
```

A bot that has collected the stones for its level lays them on the ground
and calls. The others hear the call along with the direction it came from,
and walk one square per bearing — following a bearing heard a second ago
would send them straight past the caller. When several bots call at once
they all follow the highest token, so the group converges on one square
instead of oscillating between two.

The AI protocol never tells a client the value of `t`, but every action
lasts `base/t` seconds, so the bot **measures** it at start-up by timing a
few moves (`connect_nbr` costs 0/t and gives the round trip to subtract).
Every delay it uses afterwards is expressed in time units, so it behaves the
same whether the server runs at `t=10` or `t=1000`.

### The GUI

`gui/zappy_gui.js` connects to the server as `GRAPHIC`, serves the page and
forwards every line to the browser over a WebSocket whose framing is written
out by hand — no game engine, and no third-party module at all. The page
draws the grid, the resources, the players and the eggs on a 2D canvas.

* **click any square** for a floating panel listing what is on it and who is
  standing there;
* **sound is drawn** as a ring expanding from the emitter, repeated across
  the edges of the map because the world is round — the same shortest path
  the server used to work out the direction. Kicks get a shorter red ring;
* a ritual makes its square pulse until it succeeds or fails.

---

## Choices the subject left open

| Question | What we did |
|---|---|
| How does the GUI attach? | reserved team name `GRAPHIC`, own read-only protocol — see [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| Is `inventory`'s `food` a count or a time? | a **time**, in time units: the subject's own example `food 300` is not a multiple of 126 |
| Default `t` | 100 |
| Do resources come back? | yes, every 20 time units, otherwise the game cannot be won |
| Who may join a ritual? | anybody of the right level on the square; being busy is not an obstacle |
| When are the ritual stones consumed? | when it starts, so they cannot be stolen from under the participants |
| Who is held during a ritual? | only the player who called it |
| Which resource is generated first? | it rotates, so no kind can monopolise a small map's squares |
| Does a dead player free his slot? | no — only a ship (`fork`) creates a new one |
| `K` in `moving <K>` | expressed in the *kicked* player's own frame, since he cannot guess anyone else's orientation |
| May a client launch a teammate? | yes, when a ship has arrived. It passes on nothing but the command line, so no game data is ever shared outside the server (`--no-spawn` turns it off) |

## Bonuses

* `--log` — a running commentary of every event on stderr.
* `--seed <n>` on the server and `-s <n>` on the client — reproducible runs.
* `--density <f>` — how rich the world is.
* the GUI's sound visualisation and click-to-inspect panel.

## Layout

```
zappy_server  the built engine (copied here by make)
zappy_ai      wrapper: python3 client/zappy_ai.py
zappy_gui     wrapper: node gui/zappy_gui.js

server/     the C game engine
  include/zappy.h
  src/      main args net client command world vision sound incant gui util
client/     the Python AI
  zappy_ai.py     entry point, argument parsing, launching teammates
  ai/protocol.py  the connection and the 10-command window
  ai/brain.py     survival, foraging, gatherings, rituals
  ai/rules.py     the subject's tables and the vision-cone geometry
gui/        the graphic client
  zappy_gui.js    TCP to WebSocket bridge and static server
  web/            index.html, app.js, style.css
tests/      test_protocol.py, test_ai.py, test_victory.py
scripts/    play.sh, simulate.sh, inspect_logs.sh, show_starved.sh
docs/       PROTOCOL.md
```
