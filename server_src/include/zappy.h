/*
** Zappy server -- shared declarations.
*/

#ifndef ZAPPY_H
#define ZAPPY_H

#include <stddef.h>
#include <sys/types.h>

/* ------------------------------------------------------------------ */
/* Resources                                                          */
/* ------------------------------------------------------------------ */

enum resource {
    RES_FOOD = 0,
    RES_JADE,
    RES_PERIDOT,
    RES_AMBER,
    RES_AMETHYST,
    RES_GARNET,
    RES_AMMOLITE,
    RES_COUNT
};

extern const char *const res_names[RES_COUNT];

int res_from_name(const char *name);

/* ------------------------------------------------------------------ */
/* Timing constants, expressed in time units (divide by t for seconds) */
/* ------------------------------------------------------------------ */

#define TU_ADVANCE      7
#define TU_TURN         7
#define TU_SEE          7
#define TU_INVENTORY    1
#define TU_PICK         7
#define TU_DROP         7
#define TU_KICK         7
#define TU_BROADCAST    7
#define TU_ENCHANT      300
#define TU_FORK         48
#define TU_SHIP         600
#define TU_CONNECT_NBR  0

#define FOOD_TIME_UNITS 126
#define START_FOOD      10
#define RESPAWN_PERIOD  20

#define MAX_PENDING     10
#define MAX_LEVEL       8
#define WINNER_COUNT    6

#define GUI_TEAM_NAME   "GRAPHIC"

/* A client whose unread output grows past this is cut off. */
#define OUT_LIMIT_AI    (4u << 20)
#define OUT_LIMIT_GUI   (128u << 20)
#define CLOSE_GRACE     2.0         /* seconds to flush a goodbye */

/* ------------------------------------------------------------------ */
/* World                                                              */
/* ------------------------------------------------------------------ */

typedef struct tile_s {
    int r[RES_COUNT];
} tile_t;

typedef struct world_s {
    int w;
    int h;
    tile_t *tiles;
    double density[RES_COUNT];
    int target[RES_COUNT];      /* how many of each should exist on the map */
    int have[RES_COUNT];        /* how many currently lie on the ground */
    int spawn_turn;             /* which resource gets the free slots first */
    double next_respawn;
} world_t;

/* ------------------------------------------------------------------ */
/* Orientation: 1=N 2=E 3=S 4=W (as sent to the GUI)                  */
/* ------------------------------------------------------------------ */

enum orientation { DIR_N = 1, DIR_E = 2, DIR_S = 3, DIR_W = 4 };

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */

enum action_type {
    ACT_NONE = 0,
    ACT_ADVANCE,
    ACT_RIGHT,
    ACT_LEFT,
    ACT_SEE,
    ACT_INVENTORY,
    ACT_PICK,
    ACT_DROP,
    ACT_KICK,
    ACT_BROADCAST,
    ACT_ENCHANT,
    ACT_FORK,
    ACT_CONNECT_NBR,
    ACT_KO              /* a rejected line, answered in its turn */
};

#define ARG_MAX 512

typedef struct action_s {
    int type;
    char arg[ARG_MAX];
} action_t;

/* ------------------------------------------------------------------ */
/* Teams, eggs, players, clients                                      */
/* ------------------------------------------------------------------ */

typedef struct egg_s {
    int id;
    struct team_s *team;
    int x;
    int y;
    int laid_by;
    double hatch_at;    /* when the ship arrives */
    int hatched;
    int claimed;
    struct egg_s *next;
} egg_t;

typedef struct team_s {
    char *name;
    int slots;          /* connections still available */
    int members;        /* players currently alive */
    struct team_s *next;
} team_t;

typedef struct incant_s {
    int level;              /* level being left behind */
    int x;
    int y;
    int starter;            /* the only one who asked for it */
    double due;
    int players[16];        /* participant ids */
    int nb_players;
    int dead;               /* participants who died or left the game */
    int aborted;
    struct incant_s *next;
} incant_t;

typedef struct player_s {
    int id;
    team_t *team;
    int x;
    int y;
    int dir;
    int level;
    int inv[RES_COUNT];         /* inv[RES_FOOD] is unused, see death_at */
    double death_at;            /* absolute time at which he starves */
    action_t queue[MAX_PENDING];
    int qhead;
    int qcount;
    action_t cur;               /* action being executed */
    int busy;
    double busy_until;
    incant_t *incant;
    struct client_s *cl;
    struct player_s *next;
} player_t;

enum client_state {
    CL_HANDSHAKE = 0,
    CL_AI,
    CL_GUI
};

typedef struct client_s {
    int fd;
    int state;
    char *in;
    size_t in_len;
    size_t in_cap;
    char *out;
    size_t out_len;
    size_t out_cap;
    int closing;
    double close_at;        /* give up on draining the output after this */
    player_t *pl;
    struct client_s *next;
} client_t;

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

typedef struct options_s {
    int port;
    int width;
    int height;
    char **teams;
    int nb_teams;
    int clients_per_team;
    int t;
    int log;
    unsigned int seed;
    int seeded;
    double density_scale;
} options_t;

typedef struct server_s {
    options_t opt;
    int listen_fd;
    world_t world;
    team_t *teams;
    client_t *clients;
    player_t *players;
    egg_t *eggs;
    incant_t *incants;
    int next_player_id;
    int next_egg_id;
    double start_time;
    int running;
    team_t *winner;
} server_t;

extern server_t g_srv;

/* ------------------------------------------------------------------ */
/* util.c                                                             */
/* ------------------------------------------------------------------ */

double now_sec(void);
void   log_msg(const char *fmt, ...);
void   fatal(const char *fmt, ...);
void  *xmalloc(size_t n);
void  *xcalloc(size_t n, size_t sz);
int    rnd_int(int max);          /* [0, max) */
double rnd_double(void);          /* [0, 1)   */
void   rnd_seed(unsigned int seed);

/* ------------------------------------------------------------------ */
/* args.c                                                             */
/* ------------------------------------------------------------------ */

int  parse_args(int ac, char **av, options_t *opt);
void usage(const char *prog);

/* ------------------------------------------------------------------ */
/* world.c                                                            */
/* ------------------------------------------------------------------ */

void    world_init(world_t *w, int width, int height, double scale);
void    world_free(world_t *w);
tile_t *tile_at(world_t *w, int x, int y);
int     wrap_x(world_t *w, int x);
int     wrap_y(world_t *w, int y);
int     world_spawn_resources(world_t *w);   /* returns how many were added */
void    world_tick(world_t *w, double now);
void    tile_add(world_t *w, int x, int y, int res, int n);
void    tile_take(world_t *w, int x, int y, int res, int n);
void    dir_vector(int dir, int *dx, int *dy);
void    right_vector(int dir, int *dx, int *dy);

/* ------------------------------------------------------------------ */
/* client.c                                                           */
/* ------------------------------------------------------------------ */

client_t *client_new(int fd);
void      client_close(client_t *cl);
void      client_send(client_t *cl, const char *fmt, ...);
void      client_write_raw(client_t *cl, const char *data, size_t len);
int       client_take_line(client_t *cl, char *out, size_t out_sz);
void      clients_reap(void);

team_t   *team_find(const char *name);
player_t *player_new(team_t *team, int x, int y);
void      player_remove(player_t *pl);
player_t *player_by_id(int id);
int       players_on_tile(int x, int y, player_t **out, int max);

/* ------------------------------------------------------------------ */
/* net.c                                                              */
/* ------------------------------------------------------------------ */

int  net_listen(int port);
void net_loop(void);

/* ------------------------------------------------------------------ */
/* command.c                                                          */
/* ------------------------------------------------------------------ */

void handle_line(client_t *cl, char *line);
void player_pump(player_t *pl, double now);
void game_tick(double now);
double next_deadline(double now);
int  life_units(player_t *pl, double now);

/* ------------------------------------------------------------------ */
/* vision.c / sound.c                                                 */
/* ------------------------------------------------------------------ */

char *vision_string(player_t *pl);
int   sound_direction(player_t *listener, int sx, int sy);
int   relative_direction(player_t *listener, int dir);

/* ------------------------------------------------------------------ */
/* incant.c                                                           */
/* ------------------------------------------------------------------ */

int      incant_start(player_t *pl);
void     incant_check(double now);
incant_t *incant_on_tile(int x, int y);
void     incant_drop_player(player_t *pl);

/* ------------------------------------------------------------------ */
/* gui.c                                                              */
/* ------------------------------------------------------------------ */

void gui_hello(client_t *cl);
void gui_command(client_t *cl, char *line);
void gui_broadcast(const char *fmt, ...);
void gui_tile(int x, int y);
void gui_player_new(player_t *pl);
void gui_player_pos(player_t *pl);
void gui_player_level(player_t *pl);
void gui_player_inv(player_t *pl);

#endif /* ZAPPY_H */
