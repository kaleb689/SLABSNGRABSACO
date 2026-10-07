import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('let customerLiveEvents = null;'), app.indexOf('function homepageSampleSuccessData()'));

function surface() {
  const connections = [];
  const state = { customer: null };
  const document = { visibilityState: 'visible', events: {}, addEventListener(k, fn) { this.events[k] = fn; } };
  const window = { events: {}, addEventListener(k, fn) { this.events[k] = fn; } };
  let refreshes = 0;
  class EventSource {
    constructor(url) { this.url = url; this.events = {}; this.closed = false; connections.push(this); }
    addEventListener(k, fn) { this.events[k] = fn; }
    close() { this.closed = true; }
  }
  vm.runInNewContext(source, { document, window, state, EventSource, ADMIN_PREVIEW_MODE: false,
    scheduleCustomerLiveRefresh() { refreshes++; } });
  return { state, document, window, connections, refreshes: () => refreshes };
}

test('account live feed starts on login, avoids duplicates and closes on logout', () => {
  const s = surface();
  assert.equal(s.connections.length, 0);
  s.state.customer = { id: 'customer' };
  s.document.events['account-session-changed']();
  const stream = s.connections[0];
  assert.equal(stream.url, '/api/account/live/events');
  stream.events.open();
  stream.events['data-change']();
  assert.equal(s.refreshes(), 2);
  s.document.events['account-session-changed']();
  assert.equal(s.connections.length, 1);
  s.state.customer = null;
  s.document.events['account-session-changed']();
  assert.equal(stream.closed, true);
});

test('returning from suspension reconnects and refreshes missed account changes', () => {
  const s = surface();
  s.state.customer = { id: 'customer' };
  s.document.events['account-session-changed']();
  s.document.visibilityState = 'hidden';
  s.document.events.visibilitychange();
  assert.equal(s.connections[0].closed, true);
  s.document.visibilityState = 'visible';
  s.document.events.visibilitychange();
  s.window.events.pageshow();
  assert.equal(s.connections.length, 2);
  s.connections[1].events.open();
  assert.equal(s.refreshes(), 1);
  s.window.events.pagehide();
  assert.equal(s.connections[1].closed, true);
  s.window.events.pageshow();
  assert.equal(s.connections.length, 3);
});

test('sign-in and sign-out rendering notify the live feed', () => {
  for (const name of ['showSignedIn', 'showSignedOut']) {
    const start = app.indexOf(`function ${name}()`);
    const end = app.indexOf('\nfunction ', start + 1);
    assert.match(app.slice(start, end), /document\.dispatchEvent\(new CustomEvent\("account-session-changed"\)\)/);
  }
});
