#define _POSIX_C_SOURCE 200809L

#include "zappy.h"

#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define IN_CHUNK 4096
#define LINE_MAX_LEN 2048

static void set_nonblock(int fd)
{
    int fl = fcntl(fd, F_GETFL, 0);

    if (fl < 0 || fcntl(fd, F_SETFL, fl | O_NONBLOCK) < 0)
        fatal("fcntl: %s", strerror(errno));
}

int net_listen(int port)
{
    struct sockaddr_in addr;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    int yes = 1;

    if (fd < 0)
        fatal("socket: %s", strerror(errno));
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)port);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0)
        fatal("bind on port %d: %s", port, strerror(errno));
    if (listen(fd, 128) < 0)
        fatal("listen: %s", strerror(errno));
    set_nonblock(fd);
    return fd;
}

static void accept_clients(void)
{
    for (;;) {
        int fd = accept(g_srv.listen_fd, NULL, NULL);
        client_t *cl;
        int yes = 1;

        if (fd < 0)
            return;
        set_nonblock(fd);
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
        cl = client_new(fd);
        client_send(cl, "WELCOME");
        log_msg("accepted fd=%d", fd);
    }
}

static void client_read(client_t *cl)
{
    char tmp[IN_CHUNK];
    char line[LINE_MAX_LEN];
    ssize_t n;

    n = recv(cl->fd, tmp, sizeof(tmp), 0);
    if (n == 0)
        return client_close(cl);
    if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
            client_close(cl);
        return;
    }
    if (cl->in_len + (size_t)n + 1 > cl->in_cap) {
        size_t cap = cl->in_cap ? cl->in_cap : IN_CHUNK;

        while (cl->in_len + (size_t)n + 1 > cap)
            cap *= 2;
        /* a client that never sends a newline must not eat all our memory */
        if (cap > 1 << 20) {
            log_msg("fd=%d flooded the input buffer", cl->fd);
            return client_close(cl);
        }
        cl->in = realloc(cl->in, cap);
        if (!cl->in)
            fatal("out of memory");
        cl->in_cap = cap;
    }
    memcpy(cl->in + cl->in_len, tmp, (size_t)n);
    cl->in_len += (size_t)n;
    while (!cl->closing && client_take_line(cl, line, sizeof(line)))
        handle_line(cl, line);
}

static void client_flush(client_t *cl)
{
    ssize_t n;

    if (!cl->out_len)
        return;
    n = send(cl->fd, cl->out, cl->out_len, 0);
    if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
            cl->out_len = 0;
            client_close(cl);
        }
        return;
    }
    cl->out_len -= (size_t)n;
    memmove(cl->out, cl->out + n, cl->out_len);
}

static struct pollfd *g_fds = NULL;
static client_t **g_owners = NULL;
static int g_cap = 0;

/*
** Builds the poll set, keeping a parallel array of the owning clients so
** that a connection accepted mid-iteration cannot shift the mapping.
*/
static int build_pollfds(void)
{
    int n = 1;

    for (client_t *cl = g_srv.clients; cl; cl = cl->next)
        n++;
    if (n > g_cap) {
        g_cap = n * 2;
        g_fds = realloc(g_fds, sizeof(*g_fds) * (size_t)g_cap);
        g_owners = realloc(g_owners, sizeof(*g_owners) * (size_t)g_cap);
        if (!g_fds || !g_owners)
            fatal("out of memory");
    }
    g_fds[0].fd = g_srv.listen_fd;
    g_fds[0].events = POLLIN;
    g_fds[0].revents = 0;
    g_owners[0] = NULL;
    n = 1;
    for (client_t *cl = g_srv.clients; cl; cl = cl->next) {
        g_fds[n].fd = cl->fd;
        g_fds[n].events = cl->closing ? 0 : POLLIN;
        if (cl->out_len)
            g_fds[n].events |= POLLOUT;
        g_fds[n].revents = 0;
        g_owners[n] = cl;
        n++;
    }
    return n;
}

/*
** One single-threaded, non-blocking event loop: no request can ever hang the
** server, and a slow or silent client only ever penalises itself.
*/
void net_loop(void)
{
    while (g_srv.running) {
        int nfds = build_pollfds();
        double now = now_sec();
        double deadline = next_deadline(now);
        int timeout = (int)((deadline - now) * 1000.0);
        int ready;

        if (timeout < 0)
            timeout = 0;
        if (timeout > 1000)
            timeout = 1000;
        ready = poll(g_fds, (nfds_t)nfds, timeout);
        if (ready < 0 && errno != EINTR)
            fatal("poll: %s", strerror(errno));
        for (int i = 1; ready > 0 && i < nfds; i++) {
            client_t *cl = g_owners[i];

            if (!g_fds[i].revents || cl->closing)
                continue;
            if (g_fds[i].revents & (POLLERR | POLLNVAL)) {
                client_close(cl);
                continue;
            }
            if (g_fds[i].revents & POLLIN)
                client_read(cl);
            if (!cl->closing && (g_fds[i].revents & POLLHUP))
                client_close(cl);
        }
        if (ready > 0 && (g_fds[0].revents & POLLIN))
            accept_clients();
        game_tick(now_sec());
        for (client_t *cl = g_srv.clients; cl; cl = cl->next)
            client_flush(cl);
        clients_reap();
        if (g_srv.winner)
            g_srv.running = 0;
    }
}
