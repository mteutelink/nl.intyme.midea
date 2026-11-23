const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = readFileSync(require.resolve('../drivers/airco/device.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(id = 42, failure) {
  const stored = { host: '192.0.2.1', port: 6444, token: 'token', key: 'key' };
  let attempts = 0;
  let closed = false;
  let oldClosed = false;
  const candidate = {
    deviceContext: { id, host: '192.0.2.2', port: 6445 },
    async authenticate(credentials) {
      attempts++;
      assert.equal(credentials.token, stored.token);
      assert.equal(credentials.key, stored.key);
      assert.equal(stored.host, '192.0.2.1');
      if (failure) throw failure;
    },
    close() { closed = true; },
  };
  class HomeyDevice {
    getData() { return { id: 42 }; }
    getStore() { return { ...stored }; }
    async setStoreValue(field, value) { stored[field] = value; }
  }
  const library = {
    Driver: { listDevices: async () => [candidate] },
    LANSecurityContext: class { constructor(token, key) { Object.assign(this, { token, key }); } },
  };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports,
    require: name => name === 'homey' ? { default: { Device: HomeyDevice } } : library,
  });
  const device = new mod.exports();
  device._device = { close() { oldClosed = true; } };
  return { device, candidate, stored, attempts: () => attempts, closed: () => closed, oldClosed: () => oldClosed };
}

test('same air conditioner is adopted only after one successful handshake', async () => {
  const f = fixture();
  const first = f.device.recoverAddress();
  assert.equal(f.device.recoverAddress(), first);
  assert.equal(await first, true);
  assert.equal(f.attempts(), 1);
  assert.equal(f.device._device, f.candidate);
  assert.equal(f.stored.host, '192.0.2.2');
  assert.equal(f.stored.port, 6445);
  assert.equal(f.stored.token, 'token');
  assert.equal(f.stored.key, 'key');
  assert(f.oldClosed());
  assert(!f.closed());
});

test('an unrelated device is never sent the saved credentials', async () => {
  const f = fixture(43);
  assert.equal(await f.device.recoverAddress(), false);
  assert.equal(await f.device.recoverAddress(f.candidate), false);
  assert.equal(f.attempts(), 0);
});

for (const message of ['LAN request timed out', 'Authentication failed']) {
  test(message + ' leaves the old address and credentials intact', async () => {
    const f = fixture(42, new Error(message));
    await assert.rejects(f.device.recoverAddress(), { message });
    assert.deepEqual(f.stored, { host: '192.0.2.1', port: 6444, token: 'token', key: 'key' });
    assert(f.closed());
    assert(!f.oldClosed());
  });
}
