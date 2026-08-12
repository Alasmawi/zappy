"""The autonomous player.

No human input, and no communication with the other clients outside of the
game: everything the bots agree on travels through in-game `broadcast`.
"""

import random
import time

from .protocol import Connection, Dead
from .rules import (MAX_LEVEL, STONES, needs, path_to, step_towards,
                    tile_offset)

# Life is counted in time units and drains at exactly t units per second,
# so a bot burns about one food unit for every 18 actions it takes: it has
# to keep a large larder before it can afford to stand still and call.
HUNGRY = 600           # below this, everything else stops
COMFORTABLE = 5000     # above this, stop hoarding food
RALLY_RESERVE = 2000   # life needed before committing to a gathering
RALLY_ABANDON = 900    # a ritual costs 300 on its own: leave while we can

# Delays are counted in time units too, never in seconds: the server may be
# running at any speed, and a bot that waited in wall clock seconds would
# happily starve while standing still on a fast server.
RALLY_PERIOD = 70      # time units between two rally calls
RALLY_TIMEOUT = 300    # a caller quiet for this long is dropped
RALLY_PATIENCE = 3000  # give up on a gathering after this long
FORK_PERIOD = 800      # time units between two looks at the family size
FORK_RESERVE = 2200    # calling a ship costs 48, so this is plenty
ACTIONS_PER_CHECK = 8  # how many commands between two inventories


class Bot:
    def __init__(self, host, port, team, verbose=False, spawner=None):
        self.team = team
        self.verbose = verbose
        self.spawner = spawner
        self.token = random.randint(0, 1 << 30)
        self.born = time.time()
        self.level = 1
        self.life = 1260
        self.inventory = {s: 0 for s in STONES}
        self.conn = Connection(host, port, team, log=self.say)
        self.rally = None            # (level, direction, token) we are joining
        self.rally_seen = 0.0
        self.actions = 0             # commands sent, our own clock
        self.last_inventory = -ACTIONS_PER_CHECK
        self.last_fork_check = 0.0
        self.evolving = False
        self.t = 100.0               # replaced by calibrate()
        self.calibrate()

    # -- timing ---------------------------------------------------------

    def seconds(self, time_units):
        """A delay expressed in time units, in real seconds."""
        return time_units / self.t

    def calibrate(self):
        """Works out the server's time unit.

        The AI protocol never tells us `t`, but every action lasts base/t
        seconds: timing a few `advance` gives it away.  `connect_nbr` costs
        0/t, so it measures the round trip we have to subtract.

        The *shortest* sample is the one to trust.  Scheduling noise can
        only ever make a move look slower, and a `t` guessed too low would
        stretch every delay the bot uses into a starvation sentence.
        """
        start = time.time()
        self.do("connect_nbr")
        latency = time.time() - start

        best = None
        for _ in range(5):
            start = time.time()
            self.do("advance")
            sample = time.time() - start
            best = sample if best is None else min(best, sample)
            if best > 0.5:
                break                      # a slow server, one sample is plenty
        spent = max(best - latency, 1e-4)
        self.t = max(1.0, min(10000.0, 7.0 / spent))
        self.say(f"time unit measured: t is about {self.t:.0f}")

    # -- plumbing -------------------------------------------------------

    def say(self, msg):
        if self.verbose:
            print(f"[{time.time() - self.born:7.2f}s "
                  f"{self.team}:{self.token % 1000:03d} lvl{self.level} "
                  f"life{int(self.life):5d}] {msg}", flush=True)

    def do(self, command):
        self.actions += 1
        answer = self.conn.ask(command)
        self.handle_events()
        return answer

    def batch(self, commands):
        if not commands:
            return []
        self.actions += len(commands)
        answers = self.conn.run(commands)
        self.handle_events()
        return answers

    def handle_events(self):
        for line in self.conn.poll_events():
            self.on_event(line)

    def on_event(self, line):
        if line.startswith("message "):
            direction, _, text = line[len("message "):].partition(",")
            self.on_broadcast(int(direction), text)
        elif line == "evolution in progress":
            self.evolving = True
            self.say("enrolled in a ritual")
        elif line.startswith("current level :"):
            self.level = int(line.split(":")[1])
            self.evolving = False
            self.rally = None
            self.say(f"reached level {self.level}")
        elif line.startswith("moving "):
            self.say("kicked away")
        elif line == "ko" and self.evolving:
            # only the player who started it is told; for the others the
            # wait in wait_for_ritual simply runs out
            self.evolving = False
            self.say("the ritual broke down")

    # -- in game agreements --------------------------------------------
    #
    # "Z <team> rally <level> <token>" is the only thing bots tell each other.

    def on_broadcast(self, direction, text):
        parts = text.split()
        if len(parts) != 5 or parts[0] != "Z" or parts[1] != self.team:
            return
        if parts[2] != "rally":
            return
        try:
            level, token = int(parts[3]), int(parts[4])
        except ValueError:
            return
        if token == self.token or level != self.level or self.evolving:
            return
        # Several teammates may be calling at once.  Always follow the one
        # with the highest token, otherwise we would walk towards a
        # different caller on every message and never arrive anywhere.
        following = (self.rally
                     and time.time() - self.rally_seen < self.seconds(RALLY_TIMEOUT))
        if following and token < self.rally[2]:
            return
        if not following or token != self.rally[2]:
            self.say(f"following the level {level} caller {token % 1000:03d}")
        self.rally = (level, direction, token)
        self.rally_seen = time.time()

    def call_rally(self):
        self.do(f"broadcast Z {self.team} rally {self.level} {self.token}")

    # -- world reading --------------------------------------------------

    def look(self):
        answer = self.do("see")
        if not answer or not answer.startswith("{"):
            return []
        return [square.split() for square in answer[1:-1].split(",")]

    def refresh_inventory(self, force=False):
        """Asks the server how much life is left.

        Driven by how many actions we have taken, not by the clock: an
        inventory costs a single time unit, and counting our own actions
        cannot be thrown off by a mis-measured time unit or by a busy
        machine -- both of which would otherwise let a bot starve while it
        still believed itself well fed.
        """
        if not force and self.actions - self.last_inventory < ACTIONS_PER_CHECK:
            return
        self.last_inventory = self.actions
        answer = self.do("inventory")
        if not answer or not answer.startswith("{"):
            return
        for item in answer[1:-1].split(","):
            name, _, count = item.strip().partition(" ")
            if name == "food":
                self.life = int(count)
            elif name in self.inventory:
                self.inventory[name] = int(count)

    def missing_stones(self):
        _, required = needs(self.level)
        return {s: n - self.inventory.get(s, 0)
                for s, n in required.items() if self.inventory.get(s, 0) < n}

    # -- behaviours -----------------------------------------------------

    def wanted_here(self, square):
        """What is worth picking up on the square we stand on."""
        wanted = []
        missing = self.missing_stones()
        for item in square:
            if item == "player":
                continue
            if item == "food":
                if self.life < COMFORTABLE:
                    wanted.append(item)
            elif item in missing and missing[item] > 0:
                missing[item] -= 1
                wanted.append(item)
            elif item in STONES and self.life > HUNGRY:
                wanted.append(item)      # stones are always worth carrying
        return wanted

    def pick_here(self, square):
        wanted = self.wanted_here(square)
        if not wanted:
            return False
        answers = self.batch([f"pick {item}" for item in wanted])
        for item, answer in zip(wanted, answers):
            if answer != "ok":
                continue
            if item == "food":
                self.life += 126
            else:
                self.inventory[item] = self.inventory.get(item, 0) + 1
        self.say(f"picked {[i for i, a in zip(wanted, answers) if a == 'ok']}")
        return True

    def target_square(self, view):
        """The closest visible square holding something we want."""
        missing = self.missing_stones()
        best = None
        for index, square in enumerate(view):
            if index == 0:
                continue
            score = 0
            for item in square:
                if item == "food" and self.life < COMFORTABLE:
                    score += 3 if self.life < HUNGRY else 1
                elif item in missing:
                    score += 2
                elif item in STONES:
                    score += 1
            if not score:
                continue
            forward, right = tile_offset(index)
            cost = forward + abs(right)
            rank = (-score, cost)
            if best is None or rank < best[0]:
                best = (rank, forward, right)
        return best

    def wander(self):
        moves = ["advance"]
        roll = random.random()
        if roll < 0.25:
            moves = ["left", "advance"]
        elif roll < 0.5:
            moves = ["right", "advance"]
        self.batch(moves + ["advance"])

    def forage(self):
        view = self.look()
        if not view:
            return
        if self.pick_here(view[0]):
            return
        target = self.target_square(view)
        if target is None:
            self.wander()
            return
        _, forward, right = target
        self.batch(path_to(forward, right))
        view = self.look()
        if view:
            self.pick_here(view[0])

    def players_here(self, view):
        return view[0].count("player") + 1 if view else 1

    def drop_ritual_stones(self):
        _, required = needs(self.level)
        commands = []
        for stone, count in required.items():
            have = min(count, self.inventory.get(stone, 0))
            commands += [f"drop {stone}"] * have
        answers = self.batch(commands)
        for command, answer in zip(commands, answers):
            if answer == "ok":
                stone = command.split()[1]
                self.inventory[stone] -= 1
        return commands

    def graze(self, view):
        """Eat what happens to lie under our feet.

        A bot taking part in a gathering must not walk away, but it may
        still pick up whatever grows back on the square it is standing on --
        that is often the difference between a ritual and a funeral.
        """
        if self.life >= COMFORTABLE or "food" not in view[0]:
            return False
        if self.do("pick food") == "ok":
            self.life += 126
            return True
        return False

    def stones_here(self, view):
        counts = {}
        for item in view[0]:
            if item in STONES:
                counts[item] = counts.get(item, 0) + 1
        return counts

    def lay_out_stones(self, view):
        """Makes sure the ritual stones are on the ground, not in our pockets.

        Kept up to date on every round: a passing teammate may well have
        picked one of them up again.
        """
        _, required = needs(self.level)
        down = self.stones_here(view)
        commands = []
        for stone, count in required.items():
            short = count - down.get(stone, 0)
            commands += [f"drop {stone}"] * min(short, self.inventory.get(stone, 0))
        for command, answer in zip(commands, self.batch(commands)):
            if answer == "ok":
                self.inventory[command.split()[1]] -= 1

    def evolve(self):
        """We carry the stones for our level: put them down and call."""
        players, _ = needs(self.level)
        if players == 1:
            self.drop_ritual_stones()
            answer = self.do("enchantment")
            self.say(f"solo ritual -> {answer}")
            if answer == "evolution in progress":
                self.wait_for_ritual()
            return
        if self.life < RALLY_RESERVE:
            self.forage()        # fill the larder before standing still
            return
        self.host_gathering(players)

    def host_gathering(self, players):
        """Call the family, and start as soon as enough of them showed up."""
        self.say(f"calling {players} players for a level {self.level} ritual")
        started = time.time()
        last_call = 0.0
        while time.time() - started < self.seconds(RALLY_PATIENCE):
            # two callers at the same level would deadlock: the lower token
            # gives up and walks to the other one instead
            if self.rally and self.rally[2] > self.token:
                self.say("another caller has priority, joining him")
                return
            view = self.look()
            if not view:
                return
            # the stones go down first, so that there is no gap between
            # counting the players and starting the ritual
            self.lay_out_stones(view)
            self.graze(view)
            if self.players_here(view) >= players:
                answer = self.do("enchantment")
                if answer == "evolution in progress":
                    self.say(f"ritual under way with {self.players_here(view)}")
                    self.wait_for_ritual()
                    return
                # Refused: the crowd is not all of our level.  Retrying at
                # once would only hold the bystanders still again, so give
                # the square a moment to change before asking anew.
                self.say(f"the ritual was refused ({answer})")
                self.refresh_inventory(force=True)
                if self.life < RALLY_ABANDON:
                    return
                last_call = 0.0
            if time.time() - last_call > self.seconds(RALLY_PERIOD):
                self.call_rally()
                last_call = time.time()
            self.refresh_inventory()
            if self.life < RALLY_ABANDON:
                self.say("too hungry to keep calling")
                return
        self.say("nobody came, back to foraging")

    def wait_for_ritual(self):
        """Hold still until the 300/t ritual is over, one way or the other."""
        self.evolving = True
        deadline = time.time() + self.seconds(400)
        poll = min(0.2, self.seconds(10))
        while time.time() < deadline and self.evolving:
            for line in self.conn.poll_events(poll):
                self.on_event(line)
        self.evolving = False
        self.refresh_inventory(force=True)   # standing still costs life too

    def join_gathering(self):
        """Walk towards whoever is calling, then wait on his square."""
        _, direction, _token = self.rally
        if direction == 0:
            # the caller brings the stones, we only have to stand still:
            # the server refuses to enrol a player busy with another action
            self.say("waiting on the ritual square")
            if self.life < COMFORTABLE:
                view = self.look()
                if view:
                    self.graze(view)
            deadline = time.time() + self.seconds(RALLY_TIMEOUT)
            poll = min(0.2, self.seconds(10))
            while time.time() < deadline and self.rally:
                for line in self.conn.poll_events(poll):
                    self.on_event(line)
                if self.evolving:
                    self.wait_for_ritual()
                    return
            self.refresh_inventory(force=True)
            if self.life < RALLY_ABANDON:
                self.say("starving, giving up on the gathering")
                self.rally = None
                return
            if time.time() - self.rally_seen > self.seconds(RALLY_TIMEOUT):
                self.say("the caller went quiet")
                self.rally = None
            return
        self.batch(step_towards(direction))
        # Walk one square per bearing.  Carrying on in a direction heard a
        # second ago would send us straight past the caller.
        bearing = self.rally_seen
        deadline = time.time() + self.seconds(RALLY_PERIOD * 2)
        poll = min(0.1, self.seconds(5))
        while time.time() < deadline and self.rally_seen == bearing:
            for line in self.conn.poll_events(poll):
                self.on_event(line)
        self.refresh_inventory(force=True)

    # -- team management ------------------------------------------------

    def manage_team(self):
        if time.time() - self.last_fork_check < self.seconds(FORK_PERIOD):
            return
        self.last_fork_check = time.time()
        free = self.do("connect_nbr")
        try:
            free = int(free)
        except (TypeError, ValueError):
            return
        if free > 0:
            if self.spawner:
                self.spawner(free)
            return
        # The last two rituals need six of us at once, and members are lost
        # to starvation along the way, so keep a ship on the way whenever we
        # can afford one -- it only costs 48 time units.
        if self.life > FORK_RESERVE:
            self.say("calling a ship")
            self.do("fork")

    # -- main loop ------------------------------------------------------

    def step(self):
        self.refresh_inventory()
        if self.evolving:
            self.wait_for_ritual()
            return
        if self.life < HUNGRY:
            self.forage()
            return
        if self.rally and time.time() - self.rally_seen < self.seconds(RALLY_TIMEOUT):
            # only answer a call with enough life to walk there, stand
            # around and still survive the 300 time units of the ritual
            if self.life >= RALLY_RESERVE:
                self.join_gathering()
                return
            self.forage()
            return
        self.rally = None
        self.manage_team()
        if self.level < MAX_LEVEL and not self.missing_stones():
            self.evolve()
            return
        self.forage()

    def run(self):
        try:
            while True:
                self.step()
        except Dead as why:
            self.say(f"died: {why}")
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.say("disconnected")
        finally:
            self.conn.close()
