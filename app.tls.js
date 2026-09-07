const fs = require('fs');
const path = require('path');
const net = require('net');
const {URL} = require('url');
const {Buffer} = require('buffer');
const {createServer} = require('https');
const {WebSocketServer, createWebSocketStream} = require('ws');

const UUID = process.env.UUID;
if (!UUID || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(UUID)) {
    throw new Error('UUID must be set to a valid UUID; refusing to use a public default credential');
}
const DOMAIN = process.env.DOMAIN || 'example.com';
const PORT = process.env.PORT || 3000;
const REMARKS = process.env.REMARKS || 'nodejs-vless-tls';

const options = {
    key: fs.readFileSync(path.join(__dirname, 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};

const server = createServer(options, (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    if (parsedUrl.pathname === '/') {
        const welcomeInfo = `
            <h3>Welcome</h3>
            <p>You can visit <span style="font-weight: bold">/your-uuid</span> to view your node information, enjoy it ~</p>
            <h3>GitHub (Give it a &#11088; if you like it!)</h3>
            <a href="https://github.com/vevc/nodejs-vless" target="_blank" style="color: blue">https://github.com/vevc/nodejs-vless</a>
        `;
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(welcomeInfo);
    } else if (parsedUrl.pathname === `/${UUID}`) {
        const vlessUrl = `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&fp=chrome&type=ws&host=${DOMAIN}&path=%2F#${REMARKS}`;
        const subInfo = `
            <h3>VLESS URL</h3>
            <p style="word-wrap: break-word">${vlessUrl}</p>
            <h3>GitHub (Give it a &#11088; if you like it!)</h3>
            <a href="https://github.com/vevc/nodejs-vless" target="_blank" style="color: blue">https://github.com/vevc/nodejs-vless</a>
        `;
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(subInfo);
    } else {
        res.writeHead(404, {'Content-Type': 'text/plain'});
        return res.end('Not Found');
    }
});

/**
 * Refer to: https://xtls.github.io/development/protocols/vless.html
 * Parse the client handshake message and extract the version, UUID, target host/port and message offset
 * @param {Buffer} buf Handshake Message Buffer
 * @returns {{version:number, id:Buffer, command:number, host:string, port:number, offset:number}}
 */
function parseHandshake(buf) {
    let offset = 0;
    const version = buf.readUInt8(offset);
    offset += 1;

    const id = buf.subarray(offset, offset + 16);
    offset += 16;

    const optLen = buf.readUInt8(offset);
    offset += 1 + optLen;

    const command = buf.readUInt8(offset);
    offset += 1;

    const port = buf.readUInt16BE(offset);
    offset += 2;

    const addressType = buf.readUInt8(offset);
    offset += 1;

    let host;
    if (addressType === 1) {  // IPV4
        host = Array.from(buf.subarray(offset, offset + 4)).join('.');
        offset += 4;
    } else if (addressType === 2) {  // DOMAIN
        const len = buf.readUInt8(offset++);
        host = buf.subarray(offset, offset + len).toString();
        offset += len;
    } else if (addressType === 3) {  // IPV6
        const segments = [];
        for (let i = 0; i < 8; i++) {
            segments.push(buf.readUInt16BE(offset).toString(16));
            offset += 2;
        }
        host = segments.join(':');
    } else {
        throw new Error(`Unsupported address type: ${addressType}`);
    }

    return {version, id, command, host, port, offset};
}

const uuid = Buffer.from(UUID.replace(/-/g, ''), 'hex');
const wss = new WebSocketServer({server});
wss.on('connection', ws => {
    ws.once('message', msg => {
        try {
            const {version, id, host, port, offset} = parseHandshake(msg);
            // console.log('version: ', version, 'id: ', id, 'host: ', host, 'port: ', port, 'offset: ', offset);

            if (!id.equals(uuid)) {
                return ws.close();
            }
            ws.send(Buffer.from([version, 0]));

            const duplex = createWebSocketStream(ws);
            const socket = net.connect({host, port}, () => {
                socket.write(msg.slice(offset));
                duplex.pipe(socket).pipe(duplex);
            });

            // duplex.on('error', err => console.error('Duplex error: ', err));
            // socket.on('error', err => console.error('Socket error: ', err));
            duplex.on('error', () => {});
            socket.on('error', () => {});

            socket.on('close', () => ws.terminate());
            duplex.on('close', () => socket.destroy());

        } catch (err) {
            // console.error('Handshake error: ', err);
            ws.close();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
