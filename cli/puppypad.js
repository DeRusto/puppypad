#!/usr/bin/env node
// PuppyPad's command-line tool: a thin client over the HTTP API (/api/*). No dependencies, Node 20 or newer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { parseArgs } = require('util');

const HELP = `Usage: puppypad <command> [options]

  login              save your API key (make one on your dashboard under API key)
  logout             forget the saved key
  info               your site's address, space used and limits
  list               every file on your site
  push [folder]      upload new and changed files from a folder (default: this one)
    --delete           also delete files on your site that are not in the folder
    --dry-run          show what would change without changing anything
  pull [folder]      download your site's files into a folder (default: this one)
  delete <path>...   delete files from your site

Options:
  --url <address>    your PuppyPad server (default: https://puppypad.org)
  --help             show this

PUPPYPAD_API_KEY and PUPPYPAD_URL take the place of a saved login, for scripts and CI.
Files and folders starting with a dot, and node_modules, are never uploaded.`;

const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'puppypad', 'config.json');
const DEFAULT_URL = 'https://puppypad.org';
const BATCH = 20; // the API takes at most 20 files per upload
const DELETE_BATCH = 100;

class Fail extends Error {}
const say = (s) => process.stdout.write(`${s}\n`);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };

function client(opts, needKey = true) {
  const saved = readConfig();
  const url = String(opts.url || process.env.PUPPYPAD_URL || saved.url || DEFAULT_URL).replace(/\/+$/, '');
  const key = opts.key || process.env.PUPPYPAD_API_KEY || saved.key;
  if (needKey && !key) throw new Fail('No API key. Run "puppypad login", or set PUPPYPAD_API_KEY.');
  // one request; waits out the API's per-minute limit instead of failing a big push or pull
  const call = async (method, route, body, raw = false) => {
    for (let tries = 0; ; tries++) {
      let res;
      try {
        res = await fetch(url + route, { method, body, headers: { Authorization: `Bearer ${key}` } });
      } catch (e) {
        throw new Fail(`Could not reach ${url}: ${e.cause?.message || e.message}`);
      }
      if (res.status === 429 && tries < 5) {
        const wait = Number(res.headers.get('retry-after')) || 60;
        say(`Too many requests; waiting ${wait} seconds...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Fail(data.error || `${url}${route} answered ${res.status}.`);
      return data;
    }
  };
  return { url, key, call };
}

// every file under dir as a slash-separated path, leaving out dotfiles and node_modules
function localFiles(dir) {
  const out = [];
  const walk = (d, pre) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(path.join(d, e.name), `${pre}${e.name}/`);
      else if (e.isFile()) out.push(pre + e.name);
    }
  };
  walk(dir, '');
  return out.sort();
}

function folder(arg) {
  const dir = path.resolve(arg || '.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Fail(`There is no folder called ${arg}.`);
  return dir;
}

async function push(api, dir, { delete: prune, 'dry-run': dry }) {
  const site = await api.call('GET', '/api/site');
  const remote = new Map((await api.call('GET', '/api/files')).files.map((f) => [f.path, f.sha256]));
  const types = new Set(site.allowed_types);
  const ext = (p) => (p.includes('.') ? p.split('.').pop().toLowerCase() : '');
  const allowed = (f) => !!site.any_type || types.has(ext(f)); // supporters may upload any type
  // the server stores "my page.html" as "my_page.html", so compare and delete by the stored name
  const local = new Map();
  for (const file of localFiles(dir)) {
    const name = file.replace(/\s+/g, '_');
    if (local.has(name)) throw new Fail(`${local.get(name)} and ${file} would both be stored as ${name}. Rename one.`);
    local.set(name, file);
  }
  const left = [...local.values()].filter((f) => !allowed(f));
  const big = [...local.values()].filter((f) => allowed(f) && fs.statSync(path.join(dir, f)).size > site.max_file_bytes);
  const send = [...local].filter(([name, f]) => allowed(f) && !big.includes(f) && remote.get(name) !== sha256(path.join(dir, f)));
  const gone = prune ? [...remote.keys()].filter((name) => !local.has(name)) : [];

  if (left.length) say(`Not uploading ${left.length} file${left.length === 1 ? '' : 's'} of a type PuppyPad does not host: ${left.slice(0, 10).join(', ')}${left.length > 10 ? ', ...' : ''}`);
  for (const f of big) say(`Can't upload ${f}: bigger than ${site.max_file_bytes / 1048576} MB.`);
  for (const [name] of send) say(`${dry ? 'would upload' : 'upload'}  ${name}`);
  for (const name of gone) say(`${dry ? 'would delete' : 'delete'}  ${name}`);
  if (dry) return;
  if (!send.length && !gone.length && !big.length) return say(`${site.url} is up to date.`);

  const skipped = big.map((f) => `${f} (too big)`);
  let saved = 0;
  for (let i = 0; i < send.length; i += BATCH) {
    const form = new FormData();
    for (const [name, f] of send.slice(i, i + BATCH)) form.append('files', await fs.openAsBlob(path.join(dir, f)), name);
    const r = await api.call('POST', '/api/upload', form);
    saved += r.saved.length;
    skipped.push(...r.skipped);
  }
  // an upload that didn't land may be the replacement for a file --delete would remove, so delete nothing then
  if (skipped.length) throw new Fail(`Uploaded ${saved}, but ${skipped.length} could not be: ${skipped.join(', ')}${gone.length ? '. Nothing was deleted.' : ''}`);
  let deleted = 0;
  for (let i = 0; i < gone.length; i += DELETE_BATCH) {
    deleted += (await api.call('POST', '/api/delete', new URLSearchParams(gone.slice(i, i + DELETE_BATCH).map((p) => ['paths', p])))).deleted.length;
  }
  say(`Uploaded ${saved}${prune ? `, deleted ${deleted}` : ''}. ${site.url}`);
}

async function pull(api, dir) {
  const files = (await api.call('GET', '/api/files')).files;
  const root = fs.realpathSync(dir);
  let got = 0;
  for (const f of files) {
    const to = path.join(dir, ...f.path.split('/'));
    // a symlinked folder inside the destination must not carry a download (or a folder, or a read) somewhere else;
    // checked on the deepest folder that exists, since any folder mkdir makes below it is new and can't be a link
    let have = path.dirname(to);
    while (!fs.existsSync(have)) have = path.dirname(have);
    if (path.relative(root, fs.realpathSync(have)).startsWith('..') || fs.lstatSync(to, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Fail(`Not writing ${f.path}: it leads outside ${dir} through a symlink.`);
    if (fs.existsSync(to) && sha256(to) === f.sha256) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, await api.call('GET', `/api/file?path=${encodeURIComponent(f.path)}`, undefined, true));
    say(`download  ${f.path}`);
    got++;
  }
  say(got ? `Downloaded ${got} of ${files.length} files.` : 'Everything is already here.');
}

// reads a line without echoing it, so the key stays off the screen
function askHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  });
}

async function main(argv) {
  const { values: opts, positionals: [cmd, ...rest] } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { url: { type: 'string' }, delete: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (opts.help || !cmd) return say(HELP);
  if (!['login', 'logout', 'info', 'list', 'push', 'pull', 'delete'].includes(cmd)) throw new Fail(`Unknown command "${cmd}". Run "puppypad --help".`);
  if (cmd === 'logout') { fs.rmSync(CONFIG, { force: true }); return say('Logged out.'); }
  if (cmd === 'login') {
    const { url } = client(opts, false);
    const key = process.env.PUPPYPAD_API_KEY || await askHidden(`API key for ${url} (from ${url}/dashboard/api): `);
    const site = await client({ url, key }).call('GET', '/api/site');
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify({ url, key }), { mode: 0o600 });
    return say(`Logged in as ${site.name}. Your key is saved in ${CONFIG}.`);
  }
  const api = client(opts);
  if (cmd === 'info') {
    const s = await api.call('GET', '/api/site');
    return say(`${s.name}  ${s.url}\n${(s.used_bytes / 1048576).toFixed(1)} of ${s.quota_bytes / 1048576} MB used, ${s.files} of ${s.max_files} files, ${s.hits} hits\nlast updated ${s.updated_at}`);
  }
  if (cmd === 'list') {
    for (const f of (await api.call('GET', '/api/files')).files) say(`${String(f.size).padStart(10)}  ${f.modified.slice(0, 16).replace('T', ' ')}  ${f.path}`);
    return;
  }
  if (cmd === 'push') return push(api, folder(rest[0]), opts);
  if (cmd === 'pull') {
    const dir = path.resolve(rest[0] || '.');
    fs.mkdirSync(dir, { recursive: true });
    return pull(api, dir);
  }
  if (cmd === 'delete') {
    if (!rest.length) throw new Fail('Name the files to delete, like: puppypad delete old.html pics/cat.png');
    for (let i = 0; i < rest.length; i += DELETE_BATCH) {
      const r = await api.call('POST', '/api/delete', new URLSearchParams(rest.slice(i, i + DELETE_BATCH).map((p) => ['paths', p])));
      for (const p of r.deleted) say(`deleted  ${p}`);
      for (const p of r.missing) say(`not found  ${p}`);
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`${e instanceof Fail || e.code?.startsWith('ERR_PARSE_ARGS') ? e.message : e.stack}\n`);
    process.exit(1);
  });
}
module.exports = { main };
