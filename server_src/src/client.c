#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* ------------------------------------------------------------------ */
/* Buffers                                                            */
/* ------------------------------------------------------------------ */

static void buf_reserve(char **buf, size_t *cap, size_t need)
{
    size_t n = *cap ? *cap : 1024;

    if (need <= *cap)
        return;
    while (n < need)
        n *= 2;
    *buf = realloc(*buf, n);
    if (!*buf)
        fatal("out of memory");
    *cap = n;
}

client_t *client_new(int fd)
{
    client_t *cl = xcalloc(1, sizeof(client_t));

    cl->fd = fd;
    cl->state = CL_HANDSHAKE;
    cl->next = g_srv.clients;
    g_srv.clients = cl;
    return cl;
}

void client_write_raw(client_t *cl, const char *data, size_t len)
{
    size_t limit;

    if (!cl || cl->closing)
        return;
    /*
    ** A client that stops reading must not make the server hoard its output
    ** forever: past the limit it is cut off, and everybody else carries on.
    */
    limit = cl->state == CL_GUI ? OUT_LIMIT_GUI : OUT_LIMIT_AI;
    if (cl->out_len + len > limit) {
        log_msg("fd=%d stopped reading, %zu bytes unread: cut off",
                cl->fd, cl->out_len);
        cl->out_len = 0;
        client_close(cl);
        return;
    }
    buf_reserve(&cl->out, &cl->out_cap, cl->out_len + len);
    memcpy(cl->out + cl->out_len, data, len);
    cl->out_len += len;
}

void client_send(client_t *cl, const char *fmt, ...)
{
    char stack[2048];
    char *msg = stack;
    va_list ap;
    int n;

    if (!cl || cl->closing)
        return;
    va_start(ap, fmt);
    n = vsnprintf(stack, sizeof(stack), fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    if ((size_t)n >= sizeof(stack)) {
        msg = xmalloc((size_t)n + 1);
        va_start(ap, fmt);
        vsnprintf(msg, (size_t)n + 1, fmt, ap);
        va_end(ap);
    }
    client_write_raw(cl, msg, (size_t)n);
    client_write_raw(cl, "\n", 1);
    if (msg != stack)
        free(msg);
}

/* Pops one '\n'-terminated line out of the input buffer. */
int client_take_line(client_t *cl, char *out, size_t out_sz)
{
    char *nl = cl->in ? memchr(cl->in, '\n', cl->in_len) : NULL;
    size_t len;

    if (!nl)
        return 0;
    len = (size_t)(nl - cl->in);
    if (len >= out_sz)
        len = out_sz - 1;
    memcpy(out, cl->in, len);
    out[len] = '\0';
    if (len && out[len - 1] == '\r')
        out[len - 1] = '\0';
    cl->in_len -= (size_t)(nl - cl->in) + 1;
    memmove(cl->in, nl + 1, cl->in_len);
    return 1;
}

void client_close(client_t *cl)
{
    if (!cl || cl->closing)
        return;
    cl->closing = 1;
    cl->close_at = now_sec() + CLOSE_GRACE;
    log_msg("client fd=%d disconnecting", cl->fd);
}

void clients_reap(void)
{
    client_t **pp = &g_srv.clients;
    double now = now_sec();

    while (*pp) {
        client_t *cl = *pp;

        /* let queued output drain before closing, but not for ever */
        if (cl->closing && (cl->out_len == 0 || now >= cl->close_at)) {
            *pp = cl->next;
            if (cl->pl) {
                cl->pl->cl = NULL;
                player_remove(cl->pl);
            }
            close(cl->fd);
            free(cl->in);
            free(cl->out);
            free(cl);
            continue;
        }
        pp = &cl->next;
    }
}

/* ------------------------------------------------------------------ */
/* Teams and players                                                  */
/* ------------------------------------------------------------------ */

team_t *team_find(const char *name)
{
    for (team_t *t = g_srv.teams; t; t = t->next)
        if (!strcmp(t->name, name))
            return t;
    return NULL;
}

player_t *player_new(team_t *team, int x, int y)
{
    player_t *pl = xcalloc(1, sizeof(player_t));

    pl->id = g_srv.next_player_id++;
    pl->team = team;
    pl->x = x;
    pl->y = y;
    pl->dir = 1 + rnd_int(4);
    pl->level = 1;
    pl->death_at = now_sec()
        + (double)(START_FOOD * FOOD_TIME_UNITS) / (double)g_srv.opt.t;
    pl->next = g_srv.players;
    g_srv.players = pl;
    team->members++;
    return pl;
}

player_t *player_by_id(int id)
{
    for (player_t *p = g_srv.players; p; p = p->next)
        if (p->id == id)
            return p;
    return NULL;
}

/*
** The one place a player leaves the world, whether he starved or his
** client simply went away -- so the graphic clients are told here, once.
*/
void player_remove(player_t *pl)
{
    player_t **pp = &g_srv.players;

    incant_drop_player(pl);
    gui_broadcast("pdi #%d", pl->id);
    log_msg("player #%d left the world", pl->id);
    while (*pp) {
        if (*pp == pl) {
            *pp = pl->next;
            break;
        }
        pp = &(*pp)->next;
    }
    pl->team->members--;
    if (pl->cl)
        pl->cl->pl = NULL;
    free(pl);
}

/*
** Fills `out` with the players standing on the square.  When a buffer is
** given the count is capped to it, so that callers can always iterate over
** what they were handed -- a square may hold more players than that.
*/
int players_on_tile(int x, int y, player_t **out, int max)
{
    int n = 0;

    for (player_t *p = g_srv.players; p; p = p->next) {
        if (p->x != x || p->y != y)
            continue;
        if (out) {
            if (n == max)
                return n;
            out[n] = p;
        }
        n++;
    }
    return n;
}
