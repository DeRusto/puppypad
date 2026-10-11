const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

// scripts/install.sh checks the app with a node one-liner inside the container. It also has to pass against
// releases up to v0.1.0, which only answer /healthz when Host is the public hostname, so run it against a
// server that behaves that way.
const probe = fs.readFileSync(path.join(__dirname, '../scripts/install.sh'), 'utf8').match(/node -e "(require\('http'\)[^"]*)"/)[1];

const run = (port, env) => new Promise((resolve) => {
  execFile(process.execPath, ['-e', probe.replace('port: 3000', `port: ${port}`)], { env: { ...process.env, ...env } }, (err) => resolve(err ? err.code : 0));
});

test('installer health probe sends the public hostname and only passes on 200', async () => {
  let status = 200;
  const server = http.createServer((req, res) => {
    res.statusCode = req.url === '/healthz' && req.headers.host === 'pad.example' ? status : 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, 'localhost', r));
  const { port } = server.address();
  try {
    assert.equal(await run(port, { BASE_URL: 'https://pad.example' }), 0);
    assert.equal(await run(port, { BASE_URL: 'https://other.example' }), 1);
    status = 503;
    assert.equal(await run(port, { BASE_URL: 'https://pad.example' }), 1);
  } finally {
    server.close();
  }
  assert.equal(await run(port, { BASE_URL: 'https://pad.example' }), 1); // nothing listening
});
