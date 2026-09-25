NAME    := server

CC      ?= gcc
CFLAGS  += -std=c11 -W -Wall -Wextra -Iinclude -O2
LDFLAGS += -lm

SRCDIR  := src
OBJDIR  := build

SRC     := $(wildcard $(SRCDIR)/*.c)
OBJ     := $(SRC:$(SRCDIR)/%.c=$(OBJDIR)/%.o)
DEP     := $(OBJ:.o=.d)

all: $(NAME)

$(NAME): $(OBJ)
	$(CC) -o $@ $(OBJ) $(LDFLAGS)

$(OBJDIR)/%.o: $(SRCDIR)/%.c
	@mkdir -p $(OBJDIR)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@

# Built into its own directory, so that a later plain `make` cannot link
# the normal binary against sanitized objects.
debug:
	$(MAKE) OBJDIR=build-debug \
		CFLAGS="-std=c11 -W -Wall -Wextra -Iinclude -g3 -O0 -fsanitize=address,undefined" \
		LDFLAGS="-lm -fsanitize=address,undefined" $(NAME)

clean:
	$(RM) -r $(OBJDIR) build-debug

fclean: clean
	$(RM) $(NAME)

re: fclean all

-include $(DEP)

.PHONY: all clean fclean re debug
