"""Talking to the Zappy server.

The connection keeps the ordered queue of commands the server still owes us
an answer for, and separates those answers from the messages the server may
push at any moment (broadcasts, kicks, rituals, death).
"""

import select
import socket
import time


class Dead(Exception):
    """Raised as soon as the server tells us the player starved."""


class Connection:
    MAX_PENDING = 10

    def __init__(self, host, port, team, log=None):
        self.log = log or (lambda *_: None)
        self.sock = socket.create_connection((host, port), 10)
        self.buf = b""
        self.pending = []            # commands awaiting an answer, in order
        self.answers = []            # answers received but not consumed yet
        self.events = []             # asynchronous server messages
        self.dead = False

        if self._readline() != "WELCOME":
            raise RuntimeError("the server did not greet us with WELCOME")
        self._write(team)
        answer = self._readline()
        if answer == "ko":
            raise RuntimeError(f"the server refused the team '{team}'")
        self.slots = int(answer)
        self.width, self.height = (int(v) for v in self._readline().split())
        self.log(f"connected: {self.slots} free slot(s), "
                 f"world {self.width}x{self.height}")

    # -- raw io ---------------------------------------------------------

    def _write(self, text):
        self.sock.sendall((text + "\n").encode())

    def _readline(self, timeout=None):
        while b"\n" not in self.buf:
            if timeout is not None:
                if not select.select([self.sock], [], [], timeout)[0]:
                    return None
            chunk = self.sock.recv(4096)
            if not chunk:
                raise Dead("connection closed by the server")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode(errors="replace").rstrip("\r")

    # -- classification -------------------------------------------------

    def _is_event(self, line):
        """Messages the server sends on its own, never as an answer."""
        if line.startswith("message ") or line.startswith("moving "):
            return True
        if line == "death":
            return True
        if line.startswith("current level :"):
            return True
        # 'evolution in progress' answers our own enchantment, but is pushed
        # to us when somebody else enrols us in his ritual
        if line == "evolution in progress":
            return "enchantment" not in self.pending
        return False

    def _dispatch(self, line):
        """Files an incoming line either as an answer or as an event."""
        if line == "death":
            self.dead = True
            raise Dead("we starved")
        if self._is_event(line) or not self.pending:
            # nothing is outstanding, so this cannot be an answer: it is the
            # server talking to us on its own.  Never let it shift the queue.
            self.events.append(line)
            return
        self.answers.append((self.pending.pop(0), line))

    # -- api ------------------------------------------------------------

    def send(self, command):
        """Queues a command; never lets more than 10 answers be outstanding.

        Waiting for room must *file* the answers that come in, never consume
        them: dropping one here would shift every later answer onto the
        wrong command, and the bot would be reading somebody else's reply
        for the rest of its life.
        """
        start = time.time()
        while len(self.pending) >= self.MAX_PENDING:
            line = self._readline()
            if line is None:
                break
            self._dispatch(line)
        if time.time() - start > 2.0:
            self.log(f"waited {time.time() - start:.1f}s for room to send "
                     f"'{command}'")
        self._write(command)
        self.pending.append(self._verb(command))

    def read_answer(self, timeout=None, expect=None):
        """Blocks until the next answer to a command is available.

        `expect` is the verb the answer should belong to.  A mismatch means
        the answer queue has slipped, which is silent and lethal -- a bot
        would read a `see` as its inventory -- so it is shouted about.
        """
        start = time.time()
        while not self.answers:
            line = self._readline(timeout)
            if line is None:
                return None
            self._dispatch(line)
        waited = time.time() - start
        verb, answer = self.answers.pop(0)
        if waited > 2.0:
            self.log(f"waited {waited:.1f}s for the answer to '{verb}'")
        if expect is not None and verb != expect:
            self.log(f"PROTOCOL SLIP: expected the answer to '{expect}' "
                     f"but got the one for '{verb}' ({answer!r})")
        return answer

    def ask(self, command, timeout=None):
        self.send(command)
        return self.read_answer(timeout, expect=self._verb(command))

    def run(self, commands):
        """Pipelines a batch of commands and returns all their answers."""
        for cmd in commands:
            self.send(cmd)
        return [self.read_answer(expect=self._verb(cmd)) for cmd in commands]

    @staticmethod
    def _verb(command):
        return command.split()[0] if command else command

    def poll_events(self, timeout=0.0):
        """Collects pushed messages without consuming pending answers."""
        while True:
            if b"\n" not in self.buf:
                if not select.select([self.sock], [], [], timeout)[0]:
                    break
            line = self._readline(0.0)
            if line is None:
                break
            self._dispatch(line)
            timeout = 0.0        # only the first wait may block
        out, self.events = self.events, []
        return out

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
