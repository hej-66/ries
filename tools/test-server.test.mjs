import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp } = require('../server.js');

async function startTestServer() {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

test('static server serves index.html, ries.html, assets, and blocks internal files', async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const homeRes = await fetch(`${baseUrl}/`);
  assert.equal(homeRes.status, 200);
  const homeHtml = await homeRes.text();
  assert.match(homeHtml, /RIES 12\.0\.2/);
  assert.match(homeHtml, /id="integralPanel"/);

  const aliasRes = await fetch(`${baseUrl}/integral.html`);
  assert.equal(aliasRes.status, 200);
  assert.match(await aliasRes.text(), /id="integralPanel"/);

  const riesRes = await fetch(`${baseUrl}/ries.html`);
  assert.equal(riesRes.status, 200);
  assert.match(await riesRes.text(), /ries-script\.js/);

  const assetRes = await fetch(`${baseUrl}/assets/decimal.js`);
  assert.equal(assetRes.status, 200);
  assert.match(assetRes.headers.get('content-type') || '', /javascript/);

  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  assert.deepEqual(await healthRes.json(), { ok: true });

  for (const blocked of ['/server.js', '/package.json', '/metadata.json', '/.gitignore', '/tools/test-numeric-regression.js']) {
    const res = await fetch(`${baseUrl}${blocked}`);
    assert.equal(res.status, 404, `Expected 404 for ${blocked}`);
  }
});
