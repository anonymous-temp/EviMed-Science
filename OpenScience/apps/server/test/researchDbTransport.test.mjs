import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openResearchDb } from '../src/researchDbTransport.mjs';

test('transport pins the approved DNS answer and requires certificate validation', async () => {
  let options;
  class Client { constructor(value) { options = value; } async connect() {} async end() {} on() {} }
  const connection = { host: 'db.example.org', port: 5432, database: 'data', username: 'reader', password: 'secret' };
  const result = await openResearchDb(connection, 'db.example.org:5432=8.8.8.8', { Client, resolve: async () => [{ family: 4, address: '8.8.8.8' }] });
  assert.equal(options.host, 'db.example.org'); assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(typeof options.stream, 'function'); assert.equal(options.connectionTimeoutMillis, 5000);
  await result.close();
});

test('the connection closes if the server sends too many protocol bytes', async () => {
  let client;
  class Client {
    constructor() { client = this; this.connection = new EventEmitter(); this.connection.stream = new EventEmitter();
      this.connection.stream.destroy = () => { this.destroyed = true; }; }
    async connect() { this.connection.emit('sslconnect'); } async end() {} on() {}
  }
  const connection = { host: 'db.example.org', port: 5432, database: 'data', username: 'reader', password: 'secret' };
  const opened = await openResearchDb(connection, 'db.example.org:5432=8.8.8.8', { Client, resolve: async () => [{ family: 4, address: '8.8.8.8' }] });
  client.connection.stream.emit('data', Buffer.alloc(16 * 1024 * 1024));
  assert.equal(client.destroyed, undefined);
  client.connection.stream.emit('data', Buffer.alloc(1));
  assert.equal(client.destroyed, true); await opened.close();
});
