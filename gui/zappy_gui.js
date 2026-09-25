#!/usr/bin/env node
/*
 * Zappy graphic client.
 *
 *   node gui/zappy_gui.js -p <port> [-h <host>] [--http <port>]
 *
 * It connects to the server as the reserved team "GRAPHIC", serves the
 * canvas front-end over HTTP and forwards every server line to the browser
 * through a WebSocket.  No game engine and no third party module: the
 * WebSocket framing is done by hand right here.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

// ---------------------------------------------------------------- options

function portArg(flag, text) {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        console.error(`Error: ${flag} expects a port between 1 and 65535, got '${text}'`);
        process.exit(84);
    }
    return n;
}

function parseArgs(argv) {
    const opt = { host: 'localhost', port: null, http: 8080 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-p' && argv[i + 1]) opt.port = portArg('-p', argv[++i]);
        else if (a === '-h' && argv[i + 1]) opt.host = argv[++i];
        else if (a === '--http' && argv[i + 1]) opt.http = portArg('--http', argv[++i]);
        else if (a === '--help') {
            console.log('Usage: zappy_gui.js -p <port> [-h <host>] [--http <port>]');
            process.exit(0);
        } else {
            console.error(`Error: unexpected argument '${a}'`);
            process.exit(84);
        }
    }
    if (!opt.port) {
        console.error('Usage: zappy_gui.js -p <port> [-h <host>] [--http <port>]');
        process.exit(84);
    }
    return opt;
}

const opt = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------- static server

const WEB = path.join(__dirname, 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript',
                '.css': 'text/css' };

const server = http.createServer((req, res) => {
    const name = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const file = path.join(WEB, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(file, (err, body) => {
        if (err) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
        res.end(body);
    });
});

// ------------------------------------------------------- websocket (rfc6455)

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const viewers = new Set();
// a browser tab that stops reading must not make us hoard the game for it
const VIEWER_BACKLOG_LIMIT = 64 * 1024 * 1024;

function dropViewer(socket) {
    viewers.delete(socket);
    socket.destroy();
}

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.destroy();
        return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    viewers.add(socket);
    socket.on('close', () => viewers.delete(socket));
    socket.on('end', () => dropViewer(socket));
    socket.on('error', () => dropViewer(socket));
    // the browser only listens; a close frame (opcode 8) ends the session
    socket.on('data', (buf) => {
        if (buf.length && (buf[0] & 0x0f) === 0x8) dropViewer(socket);
    });
    // the page marks replayed lines as history: they are snapshots, not news
    sendFrame(socket, 'replay begin');
    for (const line of history) if (line !== null) sendFrame(socket, line);
    sendFrame(socket, 'replay end');
});

function sendFrame(socket, text) {
    const payload = Buffer.from(text, 'utf8');
    let header;
    if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    if (socket.destroyed) {
        viewers.delete(socket);
        return;
    }
    if (socket.writableLength > VIEWER_BACKLOG_LIMIT) {
        console.error('a browser stopped reading, dropping it');
        dropViewer(socket);
        return;
    }
    try {
        socket.write(Buffer.concat([header, payload]));
    } catch (e) {
        dropViewer(socket);
    }
}

function broadcast(text) {
    for (const socket of viewers) sendFrame(socket, text);
}

/*
 * Everything needed to rebuild the world is replayed to a browser that
 * connects late: the map, the teams and the players.  Volatile events
 * (broadcasts, kicks) are not worth replaying.
 */
const history = [];
const historyIndex = new Map();

let holes = 0;

/* Dead players leave holes in the history; squeeze them out now and then. */
function compactHistory() {
    const kept = history.filter((line) => line !== null);
    history.length = 0;
    historyIndex.clear();
    for (const line of kept) {
        history.push(line);
        historyIndex.set(historyKey(line), history.length - 1);
    }
    holes = 0;
}

function forgetHistory() {
    history.length = 0;
    historyIndex.clear();
    holes = 0;
}

/* The slot a line overwrites in the history, or null if it is not kept. */
function historyKey(line) {
    const f = line.split(' ');
    if (f[0] === 'msz' || f[0] === 'sgt' || f[0] === 'seg') return f[0];
    if (f[0] === 'bct') return `bct ${f[1]} ${f[2]}`;
    if (f[0] === 'tna') return line;
    if (['pnw', 'ppo', 'plv', 'pin'].includes(f[0])) return `${f[0]} ${f[1]}`;
    if (f[0] === 'enw') return `egg ${f[1]}`;
    return null;
}

/* The slots a line wipes out: a dead player, a hatched or lost egg. */
function historyDrops(line) {
    const f = line.split(' ');
    if (f[0] === 'pdi') return ['pnw', 'ppo', 'plv', 'pin'].map((k) => `${k} ${f[1]}`);
    if (f[0] === 'ebo' || f[0] === 'edi') return [`egg ${f[1]}`];
    return [];
}

function remember(line) {
    for (const key of historyDrops(line)) {
        const at = historyIndex.get(key);
        if (at !== undefined) {
            history[at] = null;
            historyIndex.delete(key);
            holes++;
        }
    }
    if (holes > 256 && holes > history.length / 2) compactHistory();

    const key = historyKey(line);
    if (key === null) return;
    // a new world begins: whatever we knew about the old one is stale
    if (key === 'msz') forgetHistory();
    const at = historyIndex.get(key);
    if (at !== undefined) {
        history[at] = line;
    } else {
        historyIndex.set(key, history.length);
        history.push(line);
    }
}

// ------------------------------------------------------------ game socket

let buffer = '';
let retry = null;

function connect() {
    const sock = net.createConnection({ host: opt.host, port: opt.port }, () => {
        console.log(`connected to the server on ${opt.host}:${opt.port}`);
    });
    sock.setNoDelay(true);
    sock.setEncoding('utf8');

    sock.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (line === 'WELCOME') {
                sock.write('GRAPHIC\n');
                continue;
            }
            remember(line);
            broadcast(line);
        }
    });

    const down = () => {
        if (retry) return;
        console.error('lost the server, retrying in 2s');
        broadcast('sdn');           // "server down", the page greys out
        retry = setTimeout(() => { retry = null; connect(); }, 2000);
    };
    sock.on('error', down);
    sock.on('close', down);
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Error: port ${opt.http} is already in use, pick another with --http`);
    } else {
        console.error(`Error: ${err.message}`);
    }
    process.exit(84);
});

server.listen(opt.http, () => {
    console.log(`gui ready on http://localhost:${opt.http}`);
    connect();
});
