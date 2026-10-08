const yauzl = require('yauzl');

const MAX_ENTRIES = 2000;
// files that operating systems slip into zips; dropped without a word
const JUNK = (name) => name.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX') || /(^|\/)(Thumbs\.db|desktop\.ini)$/i.test(name);

async function readEntry(zip, entry) {
  const chunks = [];
  for await (const c of await zip.openReadStreamPromise(entry)) chunks.push(c);
  return Buffer.concat(chunks);
}

// Read a member's zip without trusting it. Returns { files: [{ name, data }], skipped: [reason] } with names relative
// to the zip root (one wrapping folder removed). File names still need U.safeRel before they touch the disk.
// yauzl rejects absolute and ../ names and checks every entry's real size against the size it declares,
// so a zip bomb can't push more than maxFileBytes per file or maxTotalBytes overall into memory.
async function readZip(buffer, { maxFileBytes, maxTotalBytes }) {
  const zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, autoClose: false, strictFileNames: false });
  try {
    const entries = [];
    for await (const e of zip.eachEntry()) {
      if (entries.length >= MAX_ENTRIES) throw new Error(`more than ${MAX_ENTRIES} files`);
      if (!e.fileName.endsWith('/') && !JUNK(e.fileName)) entries.push(e);
    }
    // a zip of "mysite/" holds mysite/index.html and so on: put those at the top of the target folder
    const first = entries.length && entries[0].fileName.split('/')[0];
    const strip = first && entries.every((e) => e.fileName.startsWith(first + '/')) ? first.length + 1 : 0;

    const files = [];
    const skipped = [];
    let total = 0;
    for (const e of entries) {
      const name = e.fileName.slice(strip);
      if (e.isEncrypted()) { skipped.push(`${name} (password protected)`); continue; }
      if (((e.externalFileAttributes >>> 16) & 0o170000) === 0o120000) { skipped.push(`${name} (link)`); continue; }
      if (e.uncompressedSize > maxFileBytes) { skipped.push(`${name} (too big)`); continue; }
      if (total + e.uncompressedSize > maxTotalBytes) { skipped.push(`${name} (over your space limit)`); continue; }
      const data = await readEntry(zip, e);
      total += data.length;
      files.push({ name, data });
    }
    return { files, skipped };
  } finally {
    zip.close();
  }
}

module.exports = { readZip };
