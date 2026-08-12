all: zappy_server

zappy_server:
	$(MAKE) -C server
	cp server/zappy_server ./zappy_server
	chmod +x ./zappy_ai ./zappy_gui ./scripts/*.sh

server_bin: zappy_server

test: server_bin
	python3 tests/test_protocol.py
	python3 tests/test_ai.py
	python3 tests/test_victory.py

simulate: server_bin
	./scripts/simulate.sh 90 6 200

play: server_bin
	./scripts/play.sh

clean:
	$(MAKE) -C server clean
	$(RM) -r logs
	find . -name '__pycache__' -type d -exec $(RM) -r {} + 2>/dev/null || true

fclean: clean
	$(MAKE) -C server fclean
	$(RM) ./zappy_server

re: fclean all

.PHONY: all zappy_server server_bin test simulate play clean fclean re
