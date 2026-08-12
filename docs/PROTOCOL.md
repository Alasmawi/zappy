# Zappy protocols

Two protocols share the same TCP port. Both are line based, every message
ends with `\n`, and the server never blocks on a client.

The team name a client announces during the handshake decides which one it
gets: the reserved name **`GRAPHIC`** switches the connection to the graphic
protocol, anything else is an AI player.

---

## 1. AI protocol

This is the protocol described by the subject. It is authoritative; nothing
below it was invented.

### Handshake

```
server  WELCOME
client  <team-name>
server  <nb-client>
server  <x> <y>
```

* `nb-client` — how many more clients the team can still accept *after* this
  one. A client may launch a teammate while that number is above zero.
* `x y` — the dimensions of the world.

If the team does not exist, the server prints
`Error: the team <name> doesn't exist` on its standard error, answers `ko`
and closes the connection. A team with no slot left is refused the same way.

### Commands

| Command | Delay | Answer |
|---|---|---|
| `advance` | 7/t | `ok` |
| `right` | 7/t | `ok` |
| `left` | 7/t | `ok` |
| `see` | 7/t | `{square0, square1, …}` |
| `inventory` | 1/t | `{food n, jade n, …, ammolite n}` |
| `pick <object>` | 7/t | `ok` / `ko` |
| `drop <object>` | 7/t | `ok` / `ko` |
| `kick` | 7/t | `ok` / `ko` |
| `broadcast <text>` | 7/t | `ok` |
| `enchantment` | 300/t | `evolution in progress` then `current level : K`, or `ko` |

| `fork` | 48/t | `ok` |
| `connect_nbr` | 0/t | `<number>` |

Anything else — unknown verb, missing argument, argument given to a command
that takes none — answers `ko`.

At most **10** commands may be awaiting an answer. Further commands are
dropped and never answered, exactly as the subject requires.

### Pushed messages

These arrive at any moment and are *not* answers to a command:

| Message | Meaning |
|---|---|
| `message <K>,<text>` | a broadcast, coming from square `K` |
| `moving <K>` | we were kicked towards square `K` |
| `evolution in progress` | somebody enrolled us in his ritual |
| `current level : K` | the ritual succeeded |
| `death` | we starved; the connection then closes |

Only the player who *calls* a ritual is busy for its 300 time units; the
others are enrolled but keep playing, and level up if they are still on the
square when it ends. The stones it needs are consumed the moment it starts.

A ritual that breaks down answers `ko` **to the player who started it only**.
The others are told nothing: they were never owed an answer, and a bare `ko`
arriving out of the blue could not be told apart from the answer to whatever
they had queued, which would shift every later reply onto the wrong command.
A participant knows the ritual failed because `current level` never comes.

### Square numbering

`1` is the square in front of the player and the numbering runs
counter-clockwise. `0` means "right here".

```
        3   2   1
        4   ·   8      the player looks towards 1
        5   6   7
```

The same numbering is used for `message` and for `moving`.

### `see`

Level `L` sees `L + 1` rows; row `k` holds `2k + 1` squares, listed from the
player's left to his right. Row 0 is the square he stands on, and he never
sees himself:

```
{food, player amber, garnet garnet, }
```

### `inventory`

```
{food 1260, jade 0, peridot 0, amber 0, amethyst 0, garnet 0, ammolite 0}
```

`food` is the **life left, in time units** — which is also how much time the
player has left, as the subject asks. It starts at 1260 (the 10 starting
food units, worth 126 time units each), falls by one every 1/t second, and
every `pick food` adds 126. The subject's own example (`food 300`) is not a
multiple of 126, which is what settles the question.

---

## 2. Graphic protocol

The subject does not define one, so this is our extension. A client that
announces the team `GRAPHIC` becomes a read-only observer: it can ask
questions, but nothing it sends can change the game.

On connection the server sends the whole world: `msz`, `sgt`, one `tna` per
team, one `bct` per square, one `pnw` per player and one `enw` per egg.
After that, every change is pushed as it happens.

### Server → GUI

| Message | Meaning |
|---|---|
| `msz X Y` | map size |
| `sgt T` | time unit |
| `bct X Y food jade peridot amber amethyst garnet ammolite` | contents of a square |
| `tna NAME` | a team name |
| `pnw #id X Y O L TEAM` | a player appeared (`O` is 1=N 2=E 3=S 4=W) |
| `ppo #id X Y O` | he moved or turned |
| `plv #id L` | his level changed |
| `pin #id X Y food jade peridot amber amethyst garnet ammolite` | his inventory |
| `pgt #id RESOURCE` | he picked something up |
| `pdr #id RESOURCE` | he dropped something |
| `pex #id` | he was kicked |
| `pbc #id TEXT` | he broadcast a message |
| `pfk #id` | he called a ship |
| `pic X Y L #id …` | a ritual started on that square |
| `pie X Y R` | it ended (`R` is 1 for success, 0 for failure) |
| `pdi #id` | he died |
| `enw #egg #id X Y` | an egg was laid |
| `eht #egg` | the ship arrived, a slot is free |
| `ebo #egg` | a new client took that slot |
| `edi #egg` | the egg was lost |
| `seg TEAM` | that team won |
| `smg TEXT` | a message from the server |
| `suc` | unknown command |
| `sbp` | bad parameters |

### GUI → server

`msz`, `sgt`, `mct` (the whole map), `tna`, `bct X Y`, `ppo #id`,
`plv #id`, `pin #id`. Anything else answers `suc`; a player or square that
does not exist answers `sbp`.

### Why a separate protocol

The AI protocol is deliberately partial: a player only learns what he can
see and hear. A graphic client needs the whole truth about the world, and
giving that to a connection that could also play would hand an unfair
advantage to a bot pretending to be a viewer. Splitting them on the team
name keeps the two roles apart with no extra port and no authentication.
