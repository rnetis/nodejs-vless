'use strict';
/*
 * VLESS handshake parser (RFC drafted at xtls.github.io/development/protocols/vless.html)
 * and UUID helpers. Pure, dependency-free, fully unit-testable.
 */

/**
 * Parse the client handshake message.
 * @param {Buffer} buf
 * @returns {{version:number, id:Buffer, command:number, host:string, port:number, offset:number}}
 */
function parseHandshake(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('handshake must be a buffer');
  const need = n => {
    if (offset + n > buf.length) throw new Error('truncated handshake');
  };
  let offset = 0;
  need(18);
  const version = buf.readUInt8(offset);
  offset += 1;

  const id = buf.subarray(offset, offset + 16);
  offset += 16;

  const optLen = buf.readUInt8(offset);
  offset += 1 + optLen;

  need(4);
  const command = buf.readUInt8(offset);
  if (command !== 1) throw new Error('unsupported command');
  offset += 1;

  const port = buf.readUInt16BE(offset);
  offset += 2;

  const addressType = buf.readUInt8(offset);
  offset += 1;

  let host;
  if (addressType === 1) {            // IPv4
    need(4);
    host = Array.from(buf.subarray(offset, offset + 4)).join('.');
    offset += 4;
  } else if (addressType === 2) {     // DOMAIN
    need(1);
    const len = buf.readUInt8(offset++);
    if (len === 0) throw new Error('empty domain');
    need(len);
    host = buf.subarray(offset, offset + len).toString();
    offset += len;
  } else if (addressType === 3) {     // IPv6
    need(16);
    const segments = [];
    for (let i = 0; i < 8; i++) {
      segments.push(buf.readUInt16BE(offset).toString(16));
      offset += 2;
    }
    host = segments.join(':');
  } else {
    throw new Error(`Unsupported address type: ${addressType}`);
  }

  return { version, id, command, host, port, offset };
}

/** Convert a 16-byte buffer (or hex string) into canonical UUID form. */
function bufToUuid(buf) {
  const h = Buffer.isBuffer(buf) ? buf.toString('hex') : String(buf).replace(/-/g, '');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

module.exports = { parseHandshake, bufToUuid };
