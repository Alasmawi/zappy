#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

server_t g_srv;

static void on_signal(int sig)
{
    (void)sig;
    g_srv.running = 0;
}

static void build_teams(void)
{
    team_t *tail = NULL;

    for (int i = 0; i < g_srv.opt.nb_teams; i++) {
        team_t *t = xcalloc(1, sizeof(team_t));

        t->name = g_srv.opt.teams[i];
        t->slots = g_srv.opt.clients_per_team;
        if (tail)
            tail->next = t;
        else
            g_srv.teams = t;
        tail = t;
    }
}

static void cleanup(void)
{
    while (g_srv.clients) {
        client_t *cl = g_srv.clients;

        g_srv.clients = cl->next;
        close(cl->fd);
        free(cl->in);
        free(cl->out);
        free(cl);
    }
    while (g_srv.players) {
        player_t *p = g_srv.players;

        g_srv.players = p->next;
        free(p);
    }
    while (g_srv.eggs) {
        egg_t *e = g_srv.eggs;

        g_srv.eggs = e->next;
        free(e);
    }
    while (g_srv.incants) {
        incant_t *ic = g_srv.incants;

        g_srv.incants = ic->next;
        free(ic);
    }
    while (g_srv.teams) {
        team_t *t = g_srv.teams;

        g_srv.teams = t->next;
        free(t);
    }
    for (int i = 0; i < g_srv.opt.nb_teams; i++)
        free(g_srv.opt.teams[i]);
    free(g_srv.opt.teams);
    world_free(&g_srv.world);
}

int main(int ac, char **av)
{
    unsigned int seed;

    if (ac == 1) {
        usage(av[0]);
        return 84;
    }
    if (parse_args(ac, av, &g_srv.opt) < 0)
        return 84;
    signal(SIGPIPE, SIG_IGN);
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    seed = g_srv.opt.seeded ? g_srv.opt.seed
                            : (unsigned int)time(NULL) ^ (unsigned int)getpid();
    rnd_seed(seed);
    g_srv.start_time = now_sec();
    g_srv.next_player_id = 1;
    g_srv.next_egg_id = 1;
    g_srv.running = 1;
    build_teams();
    world_init(&g_srv.world, g_srv.opt.width, g_srv.opt.height,
               g_srv.opt.density_scale);
    g_srv.world.next_respawn = g_srv.start_time
        + (double)RESPAWN_PERIOD / (double)g_srv.opt.t;
    g_srv.listen_fd = net_listen(g_srv.opt.port);
    printf("Zappy server listening on port %d\n", g_srv.opt.port);
    printf("  world %dx%d, t=%d, %d client(s) per team\n",
           g_srv.opt.width, g_srv.opt.height, g_srv.opt.t,
           g_srv.opt.clients_per_team);
    printf("  teams:");
    for (int i = 0; i < g_srv.opt.nb_teams; i++)
        printf(" %s", g_srv.opt.teams[i]);
    printf("\n  seed: %u\n", seed);
    fflush(stdout);
    net_loop();
    close(g_srv.listen_fd);
    cleanup();
    return 0;
}
