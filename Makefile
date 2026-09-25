# ./server  the C game engine            (built from server_src/)
# ./client  the autonomous AI player     (wrapper around client_src/)
# ./zappy_gui  the graphic client        (wrapper around gui/)

all: server

server: FORCE
	$(MAKE) -C server_src
	cp server_src/server ./server
	chmod +x ./client ./zappy_gui ./scripts/*.sh

test: server
	python3 tests/test_protocol.py
	python3 tests/test_ai.py
	python3 tests/test_victory.py

simulate: server
	./scripts/simulate.sh 90 6 200

play: server
	./scripts/play.sh

clean:
	$(MAKE) -C server_src clean
	$(RM) -r logs
	find . -name '__pycache__' -type d -exec $(RM) -r {} + 2>/dev/null || true

fclean: clean
	$(MAKE) -C server_src fclean
	$(RM) ./server

re: fclean all

FORCE:

.PHONY: all test simulate play clean fclean re FORCE
