'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('只在创建剧本杀房间时向该房间发送组局消息', async () => {
  const events = {};
  const modes = [];
  const sent = [];
  const apiCalls = [];
  let current = { id: 'room-a' };
  const CNGP = {
    roomMode: mode => modes.push(mode),
    on: (event, callback) => { events[event] = callback; },
    context: () => ({ conv: current }),
    send: message => sent.push(message),
    api: async (url, options) => { apiCalls.push({ url, options }); },
    toast: () => {},
  };
  vm.runInNewContext(fs.readFileSync(__dirname + '/murder-mystery.js', 'utf8'),
    { window: {}, CNGP, crypto: { randomUUID: () => 'unique-id' }, Date, Math, encodeURIComponent });
  assert.equal(modes[0].id, 'murder-mystery');
  events['room-created']({ mode: 'undercover', conv: { id: 'room-a' } });
  assert.equal(sent.length, 0);
  events['room-created']({ mode: 'murder-mystery', conv: { id: 'room-a' } });
  assert.match(sent[0], /剧本杀组局已发起/);
  current = { id: 'another-room' };
  events['room-created']({ mode: 'murder-mystery', conv: { id: 'room-b' } });
  await Promise.resolve();
  assert.equal(apiCalls[0].url, '/api/conversations/room-b/send');
  assert.equal(apiCalls[0].options.body.client_msg_id, 'unique-id');
});
