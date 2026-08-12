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

function parseArgs(argv) {
    const opt = { host: 'localhost', port: null, http: 8080 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-p' && argv[i + 1]) opt.port = parseInt(argv[++i], 10);
        else if (a === '-h' && argv[i + 1]) opt.host = argv[++i];
        else if (a === '--http' && argv[i + 1]) opt.http = parseInt(argv[++i], 10);
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
    socket.on('error', () => viewers.delete(socket));
    // the browser only listens, but a client frame must not desync us
    socket.on('data', () => {});
    for (const line of history) sendFrame(socket, line);
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
    try {
        socket.write(Buffer.concat([header, payload]));
    } catch (e) {
        viewers.delete(socket);
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

function remember(line) {
    const f = line.split(' ');
    let key = null;
    if (f[0] === 'msz' || f[0] === 'sgt') key = f[0];
    else if (f[0] === 'bct') key = `bct ${f[1]} ${f[2]}`;
    else if (f[0] === 'tna') key = line;
    else if (['pnw', 'ppo', 'plv', 'pin'].includes(f[0])) key = `${f[0]} ${f[1]}`;
    else if (f[0] === 'pdi') {
        for (const k of ['pnw', 'ppo', 'plv', 'pin']) {
            const at = historyIndex.get(`${k} ${f[1]}`);
            if (at !== undefined) {
                history[at] = null;
                historyIndex.delete(`${k} ${f[1]}`);
            }
        }
        return;
    } else return;

    const at = historyIndex.get(key);
    if (at !== undefined && history[at] !== null) {
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

server.listen(opt.http, () => {
    console.log(`gui ready on http://localhost:${opt.http}`);
    connect();
});
