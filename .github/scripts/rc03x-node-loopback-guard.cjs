'use strict';

const net = require('node:net');
const tls = require('node:tls');

function normalizedHost(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopback(host) {
  const value = normalizedHost(host);
  return value === '' || value === 'localhost' || value === '::1' ||
    value === '0:0:0:0:0:0:0:1' || value.startsWith('127.');
}

function connectionTarget(args) {
  const first = args[0];
  if (Array.isArray(first)) {
    return connectionTarget(first);
  }
  if (first && typeof first === 'object') {
    return { host: first.hostname ?? first.host ?? 'localhost', port: first.port ?? '' };
  }
  if (typeof first === 'number') {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
  }
  return { host: 'localhost', port: '' };
}

function assertLoopback(args) {
  const { host, port } = connectionTarget(args);
  if (!isLoopback(host)) {
    const label = `${normalizedHost(host)}${port ? `:${port}` : ''}`;
    process.stderr.write(`[RC02B_NETWORK_BLOCK] node ${label}\n`);
    throw new Error(`RC-02B blocked non-loopback Node connection to ${label}`);
  }
}

const netConnect = net.connect;
net.connect = function guardedNetConnect(...args) {
  assertLoopback(args);
  return netConnect.apply(this, args);
};
net.createConnection = net.connect;

const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  assertLoopback(args);
  return socketConnect.apply(this, args);
};

const tlsConnect = tls.connect;
tls.connect = function guardedTlsConnect(...args) {
  assertLoopback(args);
  return tlsConnect.apply(this, args);
};

