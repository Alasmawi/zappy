#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct cmd_def_s {
    const char *name;
    int type;
    int duration;       /* in time units */
    int takes_arg;
} cmd_def_t;

static const cmd_def_t commands[] = {
    {"advance",     ACT_ADVANCE,     TU_ADVANCE,     0},
    {"right",       ACT_RIGHT,       TU_TURN,        0},
    {"left",        ACT_LEFT,        TU_TURN,        0},
    {"see",         ACT_SEE,         TU_SEE,         0},
    {"inventory",   ACT_INVENTORY,   TU_INVENTORY,   0},
    {"pick",        ACT_PICK,        TU_PICK,        1},
    {"drop",        ACT_DROP,        TU_DROP,        1},
    {"kick",        ACT_KICK,        TU_KICK,        0},
    {"broadcast",   ACT_BROADCAST,   TU_BROADCAST,   1},
    {"enchantment", ACT_ENCHANT,     TU_ENCHANT,     0},
    {"fork",        ACT_FORK,        TU_FORK,        0},
    {"connect_nbr", ACT_CONNECT_NBR, TU_CONNECT_NBR, 0},
    {NULL, 0, 0, 0}
};

static const cmd_def_t *cmd_lookup(int type)
{
    for (int i = 0; commands[i].name; i++)
        if (commands[i].type == type)
            return &commands[i];
    return NULL;
}

int life_units(player_t *pl, double now)
{
    double u = (pl->death_at - now) * (double)g_srv.opt.t;

    return u < 0 ? 0 : (int)u;
}

/* ------------------------------------------------------------------ */
/* Handshake                                                          */
/* ------------------------------------------------------------------ */

static egg_t *egg_claim(team_t *team)
{
    for (egg_t *e = g_srv.eggs; e; e = e->next)
        if (e->team == team && e->hatched && !e->claimed)
            return e;
    return NULL;
}

static void egg_release(egg_t *egg)
{
    egg_t **pp = &g_srv.eggs;

    while (*pp) {
        if (*pp == egg) {
            *pp = egg->next;
            free(egg);
            return;
        }
        pp = &(*pp)->next;
    }
}

static void handshake(client_t *cl, char *line)
{
    team_t *team;
    player_t *pl;
    egg_t *egg;
    int x;
    int y;

    if (!strcmp(line, GUI_TEAM_NAME)) {
        cl->state = CL_GUI;
        gui_hello(cl);
        log_msg("fd=%d attached as graphic client", cl->fd);
        return;
    }
    team = team_find(line);
    if (!team) {
        fprintf(stderr, "Error: the team %s doesn't exist\n", line);
        client_send(cl, "ko");
        client_close(cl);
        return;
    }
    if (team->slots <= 0) {
        fprintf(stderr, "Error: the team %s is full\n", line);
        client_send(cl, "ko");
        client_close(cl);
        return;
    }
    team->slots--;
    egg = egg_claim(team);
    if (egg) {
        x = egg->x;
        y = egg->y;
        gui_broadcast("ebo #%d", egg->id);
        egg_release(egg);
    } else {
        x = rnd_int(g_srv.world.w);
        y = rnd_int(g_srv.world.h);
    }
    pl = player_new(team, x, y);
    pl->cl = cl;
    cl->pl = pl;
    cl->state = CL_AI;
    client_send(cl, "%d", team->slots);
    client_send(cl, "%d %d", g_srv.world.w, g_srv.world.h);
    gui_player_new(pl);
    log_msg("player #%d joined %s at (%d,%d) dir=%d",
            pl->id, team->name, pl->x, pl->y, pl->dir);
}

/* ------------------------------------------------------------------ */
/* Queueing                                                           */
/* ------------------------------------------------------------------ */

static void enqueue(player_t *pl, const cmd_def_t *def, const char *arg)
{
    action_t *slot;

    /* at most 10 requests may be in flight, the rest is dropped */
    if (pl->qcount >= MAX_PENDING) {
        log_msg("player #%d exceeded %d pending commands, '%s' dropped",
                pl->id, MAX_PENDING, def->name);
        return;
    }
    slot = &pl->queue[(pl->qhead + pl->qcount) % MAX_PENDING];
    slot->type = def->type;
    slot->arg[0] = '\0';
    if (arg)
        snprintf(slot->arg, sizeof(slot->arg), "%s", arg);
    pl->qcount++;
}

void handle_line(client_t *cl, char *line)
{
    char *arg;
    player_t *pl = cl->pl;

    if (cl->state == CL_HANDSHAKE)
        return handshake(cl, line);
    if (cl->state == CL_GUI)
        return gui_command(cl, line);
    if (!pl)
        return;
    while (*line == ' ')
        line++;
    arg = strchr(line, ' ');
    if (arg) {
        *arg++ = '\0';
        while (*arg == ' ')
            arg++;
    }
    for (int i = 0; commands[i].name; i++) {
        if (strcmp(line, commands[i].name))
            continue;
        if (commands[i].takes_arg && (!arg || !*arg))
            break;
        if (!commands[i].takes_arg && arg && *arg)
            break;
        enqueue(pl, &commands[i], arg);
        return;
    }
    client_send(cl, "ko");
}

/* ------------------------------------------------------------------ */
/* Execution                                                          */
/* ------------------------------------------------------------------ */

static void do_move(player_t *pl)
{
    int dx;
    int dy;

    dir_vector(pl->dir, &dx, &dy);
    pl->x = wrap_x(&g_srv.world, pl->x + dx);
    pl->y = wrap_y(&g_srv.world, pl->y + dy);
    gui_player_pos(pl);
}

static void do_inventory(player_t *pl, double now)
{
    char buf[512];
    int n = snprintf(buf, sizeof(buf), "{food %d", life_units(pl, now));

    for (int r = RES_JADE; r < RES_COUNT; r++)
        n += snprintf(buf + n, sizeof(buf) - (size_t)n, ", %s %d",
                      res_names[r], pl->inv[r]);
    snprintf(buf + n, sizeof(buf) - (size_t)n, "}");
    client_send(pl->cl, "%s", buf);
}

static void do_pick(player_t *pl, const char *what)
{
    int res = res_from_name(what);
    tile_t *tl = tile_at(&g_srv.world, pl->x, pl->y);

    if (res < 0 || tl->r[res] <= 0)
        return client_send(pl->cl, "ko");
    tile_take(&g_srv.world, pl->x, pl->y, res, 1);
    if (res == RES_FOOD)
        pl->death_at += (double)FOOD_TIME_UNITS / (double)g_srv.opt.t;
    else
        pl->inv[res]++;
    client_send(pl->cl, "ok");
    gui_broadcast("pgt #%d %s", pl->id, res_names[res]);
    gui_player_inv(pl);
    gui_tile(pl->x, pl->y);
}

static void do_drop(player_t *pl, const char *what, double now)
{
    int res = res_from_name(what);

    if (res < 0)
        return client_send(pl->cl, "ko");
    if (res == RES_FOOD) {
        if (life_units(pl, now) < FOOD_TIME_UNITS)
            return client_send(pl->cl, "ko");
        pl->death_at -= (double)FOOD_TIME_UNITS / (double)g_srv.opt.t;
    } else {
        if (pl->inv[res] <= 0)
            return client_send(pl->cl, "ko");
        pl->inv[res]--;
    }
    tile_add(&g_srv.world, pl->x, pl->y, res, 1);
    client_send(pl->cl, "ok");
    gui_broadcast("pdr #%d %s", pl->id, res_names[res]);
    gui_player_inv(pl);
    gui_tile(pl->x, pl->y);
}

static void do_kick(player_t *pl)
{
    player_t *tile[64];
    int nb = players_on_tile(pl->x, pl->y, tile, 64);
    int dx;
    int dy;
    int kicked = 0;

    if (incant_on_tile(pl->x, pl->y))
        return client_send(pl->cl, "ko");
    dir_vector(pl->dir, &dx, &dy);
    for (int i = 0; i < nb; i++) {
        player_t *o = tile[i];

        if (o == pl)
            continue;
        client_send(o->cl, "moving %d", relative_direction(o, pl->dir));
        o->x = wrap_x(&g_srv.world, o->x + dx);
        o->y = wrap_y(&g_srv.world, o->y + dy);
        gui_player_pos(o);
        gui_broadcast("pex #%d", o->id);
        kicked++;
    }
    client_send(pl->cl, kicked ? "ok" : "ko");
}

static void do_broadcast(player_t *pl, const char *text)
{
    for (player_t *o = g_srv.players; o; o = o->next) {
        if (o == pl)
            continue;
        client_send(o->cl, "message %d,%s", sound_direction(o, pl->x, pl->y), text);
    }
    client_send(pl->cl, "ok");
    gui_broadcast("pbc #%d %s", pl->id, text);
}

static void do_fork(player_t *pl)
{
    egg_t *egg = xcalloc(1, sizeof(egg_t));

    egg->id = g_srv.next_egg_id++;
    egg->team = pl->team;
    egg->x = pl->x;
    egg->y = pl->y;
    egg->laid_by = pl->id;
    egg->hatch_at = now_sec() + (double)TU_SHIP / (double)g_srv.opt.t;
    egg->next = g_srv.eggs;
    g_srv.eggs = egg;
    client_send(pl->cl, "ok");
    gui_broadcast("pfk #%d", pl->id);
    gui_broadcast("enw #%d #%d %d %d", egg->id, pl->id, egg->x, egg->y);
    log_msg("player #%d called a ship for %s (egg #%d)",
            pl->id, pl->team->name, egg->id);
}

static void execute(player_t *pl, double now)
{
    switch (pl->cur.type) {
    case ACT_ADVANCE:
        do_move(pl);
        client_send(pl->cl, "ok");
        break;
    case ACT_RIGHT:
        pl->dir = pl->dir % 4 + 1;
        gui_player_pos(pl);
        client_send(pl->cl, "ok");
        break;
    case ACT_LEFT:
        pl->dir = (pl->dir + 2) % 4 + 1;
        gui_player_pos(pl);
        client_send(pl->cl, "ok");
        break;
    case ACT_SEE: {
        char *v = vision_string(pl);

        client_send(pl->cl, "%s", v);
        free(v);
        break;
    }
    case ACT_INVENTORY:
        do_inventory(pl, now);
        break;
    case ACT_PICK:
        do_pick(pl, pl->cur.arg);
        break;
    case ACT_DROP:
        do_drop(pl, pl->cur.arg, now);
        break;
    case ACT_KICK:
        do_kick(pl);
        break;
    case ACT_BROADCAST:
        do_broadcast(pl, pl->cur.arg);
        break;
    case ACT_FORK:
        do_fork(pl);
        break;
    case ACT_CONNECT_NBR:
        client_send(pl->cl, "%d", pl->team->slots);
        break;
    default:
        break;
    }
    pl->cur.type = ACT_NONE;
}

/*
** Starts the next queued command, and completes the running one when its
** time is up.  A long action only ever blocks its own player.
*/
void player_pump(player_t *pl, double now)
{
    const cmd_def_t *def;

    for (;;) {
        if (pl->busy) {
            if (now < pl->busy_until)
                return;
            pl->busy = 0;
            execute(pl, now);
            continue;
        }
        if (pl->qcount == 0)
            return;
        pl->cur = pl->queue[pl->qhead];
        pl->qhead = (pl->qhead + 1) % MAX_PENDING;
        pl->qcount--;
        def = cmd_lookup(pl->cur.type);
        if (!def)
            return;
        if (pl->cur.type == ACT_ENCHANT) {
            /* the ritual manages its own timer and freezes participants */
            pl->cur.type = ACT_NONE;
            if (!incant_start(pl))
                client_send(pl->cl, "ko");
            continue;
        }
        pl->busy = 1;
        pl->busy_until = now + (double)def->duration / (double)g_srv.opt.t;
    }
}

/* ------------------------------------------------------------------ */
/* Global tick                                                        */
/* ------------------------------------------------------------------ */

static void eggs_tick(double now)
{
    for (egg_t *e = g_srv.eggs; e; e = e->next) {
        if (e->hatched || now < e->hatch_at)
            continue;
        e->hatched = 1;
        e->team->slots++;
        gui_broadcast("eht #%d", e->id);
        log_msg("egg #%d hatched, %s has %d free slot(s)",
                e->id, e->team->name, e->team->slots);
    }
}

void game_tick(double now)
{
    player_t *next;

    world_tick(&g_srv.world, now);
    eggs_tick(now);
    incant_check(now);
    for (player_t *pl = g_srv.players; pl; pl = next) {
        next = pl->next;
        if (now >= pl->death_at) {
            log_msg("player #%d starved to death", pl->id);
            client_send(pl->cl, "death");
            if (pl->cl)
                client_close(pl->cl);
            else
                player_remove(pl);
            continue;
        }
        player_pump(pl, now);
    }
}

/* When must the loop wake up again? */
double next_deadline(double now)
{
    double best = now + 1.0;

    if (g_srv.world.next_respawn < best)
        best = g_srv.world.next_respawn;
    for (egg_t *e = g_srv.eggs; e; e = e->next)
        if (!e->hatched && e->hatch_at < best)
            best = e->hatch_at;
    for (incant_t *ic = g_srv.incants; ic; ic = ic->next)
        if (ic->due < best)
            best = ic->due;
    for (player_t *pl = g_srv.players; pl; pl = pl->next) {
        if (pl->death_at < best)
            best = pl->death_at;
        if (pl->busy && pl->busy_until < best)
            best = pl->busy_until;
        if (!pl->busy && pl->qcount > 0)
            best = now;
    }
    return best < now ? now : best;
}
