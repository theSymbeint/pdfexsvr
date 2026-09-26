#!/usr/bin/env node
/**
 * Local dev bootstrap for pdfexsvr against a local PocketBase v0.40 instance.
 *
 * Creates the collections and seed records the server expects:
 *   apikeys, templates, pTokens, fonts, images  (+ an `apikey` field on `users`)
 *
 * Idempotent - safe to re-run. Requires a running PocketBase:
 *   ./pocketbase serve --http=127.0.0.1:8090 --dir ./pb_data
 *
 * Usage:
 *   node scripts/dev-pocketbase-setup.mjs
 *   PB_URL=http://127.0.0.1:8090 PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... node scripts/dev-pocketbase-setup.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const PB = process.env.PB_URL ?? 'http://127.0.0.1:8090';
const EMAIL = process.env.PB_SUPERUSER_EMAIL ?? 'dandre@local.dev';
const PASS = process.env.PB_SUPERUSER_PASSWORD ?? 'pdfexlocal123';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Seed values - keep in sync with scripts/dev-local.sh
const API_KEY = 'dev-api-key-123';
const USER_EMAIL = 'dev@local.dev';
const USER_PASSWORD = 'devlocal12345';
const USER_APIKEY = 'dev-user-key-123';
const DOC_NAME = 'dev-ticket';
const WHITE_PAGE = 'white-page.png';

// Minimal solid-colour PNG encoder, so the bootstrap needs no extra binary asset.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function api(pathname, { method = 'GET', body, token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = token;
  if (body && !form) headers['Content-Type'] = 'application/json';
  const res = await fetch(PB + pathname, {
    method,
    headers,
    body: form ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 400)}`);
  }
  return data;
}

async function ensureCollection(token, def) {
  const filter = encodeURIComponent(`name = "${def.name}"`);
  const existing = (await api(`/api/collections?perPage=1&filter=${filter}`, { token })).items[0];

  if (!existing) {
    await api('/api/collections', { method: 'POST', token, body: def });
    console.log(`  + created collection ${def.name}`);
    return;
  }

  // Merge fields by name so re-runs don't duplicate columns and existing ids are kept.
  const byName = new Map(existing.fields.map((f) => [f.name, f]));
  const fields = def.fields.map((f) => ({ ...(byName.get(f.name) ?? {}), ...f }));
  await api(`/api/collections/${existing.id}`, {
    method: 'PATCH',
    token,
    body: {
      fields,
      listRule: def.listRule ?? null,
      viewRule: def.viewRule ?? null,
      createRule: def.createRule ?? null,
      updateRule: def.updateRule ?? null,
      deleteRule: def.deleteRule ?? null,
    },
  });
  console.log(`  ~ updated collection ${def.name}`);
}

/**
 * @param fields  record fields (no file fields)
 * @param file    optional {field, name, data} upload, only sent on create
 */
async function upsertRecord(token, collection, filterField, filterValue, fields, file) {
  const filter = encodeURIComponent(`${filterField} = "${filterValue}"`);
  const found = (
    await api(`/api/collections/${collection}/records?perPage=1&filter=${filter}`, { token })
  ).items[0];

  const textFields = { ...fields };
  if (file) delete textFields[file.field];

  if (!found) {
    const form = new FormData();
    for (const [k, v] of Object.entries(textFields)) {
      form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    if (file) form.append(file.field, new Blob([file.data]), file.name);
    const rec = await api(`/api/collections/${collection}/records`, {
      method: 'POST',
      token,
      body: form,
      form: true,
    });
    console.log(`  + ${collection}/${rec.id} (${filterValue})`);
    return rec;
  }

  // Field-only update - never resend the file name, PB reads it as a new upload.
  await api(`/api/collections/${collection}/records/${found.id}`, {
    method: 'PATCH',
    token,
    body: textFields,
  });
  console.log(`  ~ ${collection}/${found.id} (${filterValue})`);
  return found;
}

const TOKEN = (
  await api('/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    body: { identity: EMAIL, password: PASS },
  })
).token;
console.log(`Authenticated against ${PB} as ${EMAIL}`);

const collections = (await api('/api/collections?perPage=200', { token: TOKEN })).items;
const users = collections.find((c) => c.name === 'users');
if (!users) throw new Error('no `users` collection - is this a PocketBase v0.40+ instance?');

// /pdf-test looks API keys up on the users collection, so it needs an apikey column.
// Pass the existing fields through verbatim (they carry options PB needs) and append one.
await ensureCollection(TOKEN, {
  name: 'users',
  type: 'auth',
  fields: [...users.fields.map((f) => ({ ...f })), { name: 'apikey', type: 'text', max: 255 }],
});

const usersId = users.id;

const REL = (collectionId) => ({
  type: 'relation',
  collectionId,
  cascadeDelete: false,
  minSelect: 0,
  maxSelect: 1,
});

console.log('Collections:');
await ensureCollection(TOKEN, {
  name: 'apikeys',
  type: 'base',
  fields: [
    { name: 'apikey', type: 'text', required: true, max: 255 },
    { name: 'userId', required: false, ...REL(usersId) },
  ],
});
await ensureCollection(TOKEN, {
  name: 'templates',
  type: 'base',
  fields: [
    { name: 'docName', type: 'text', required: true, max: 255 },
    { name: 'doc', type: 'text', required: true, max: 0 },
    { name: 'testData', type: 'text', required: false, max: 0 },
    { name: 'userId', required: false, ...REL(usersId) },
  ],
});
await ensureCollection(TOKEN, {
  name: 'pTokens',
  type: 'base',
  fields: [
    { name: 'tempId', type: 'text', required: true, max: 255 },
    { name: 'docData', type: 'text', required: true, max: 0 },
    { name: 'docReqCount', type: 'number', required: false },
    { name: 'active', type: 'bool', required: false },
  ],
});
// fonts/images are fetched by the app WITHOUT auth headers (see lib/resource_loader.ts),
// so their list/view rules must be public for file downloads to work.
await ensureCollection(TOKEN, {
  name: 'fonts',
  type: 'base',
  listRule: '',
  viewRule: '',
  fields: [
    { name: 'name', type: 'text', required: true, max: 255 },
    { name: 'file', type: 'file', required: true, maxSelect: 1, maxSize: 20971520 },
  ],
});
await ensureCollection(TOKEN, {
  name: 'images',
  type: 'base',
  listRule: '',
  viewRule: '',
  fields: [
    { name: 'name', type: 'text', required: true, max: 255 },
    { name: 'file', type: 'file', required: true, maxSelect: 1, maxSize: 20971520 },
  ],
});

console.log('Users + API keys:');
const user = await upsertRecord(
  TOKEN,
  'users',
  'email',
  USER_EMAIL,
  {
    email: USER_EMAIL,
    password: USER_PASSWORD,
    passwordConfirm: USER_PASSWORD,
    verified: true,
    apikey: USER_APIKEY,
  },
  null,
);
const apikeyRec = await upsertRecord(
  TOKEN,
  'apikeys',
  'apikey',
  API_KEY,
  { apikey: API_KEY, userId: user.id },
  null,
);

console.log('Assets:');
const roboto = await readFile(path.join(ROOT, 'public/fonts/Roboto-Regular.ttf'));
await upsertRecord(TOKEN, 'fonts', 'name', 'Roboto', { name: 'Roboto' }, {
  field: 'file',
  data: roboto,
  name: 'Roboto-Regular.ttf',
});
const logo = await readFile(path.join(ROOT, 'public/images/test.png'));
await upsertRecord(TOKEN, 'images', 'name', 'test.png', { name: 'test.png' }, {
  field: 'file',
  data: logo,
  name: 'test.png',
});
// Backgrounds are drawn before shapes/labels/data, so a full-page white image is
// the reliable way to get an opaque white page (a white rect in `shapes` would
// paint over every bgImage).
await upsertRecord(TOKEN, 'images', 'name', WHITE_PAGE, { name: WHITE_PAGE }, {
  field: 'file',
  data: solidPng(8, 8, [255, 255, 255]),
  name: WHITE_PAGE,
});

console.log('Template:');
// A4 portrait is 595.28 x 841.89pt. Field names match src/data/template.data.ts fixtures.
const templatePage = {
  format: 'A4',
  orientation: 'portrait',
  margin: 0,
  baseFont: 'Roboto',
  baseFontSize: 10,
  allowLineBreak: true,
  fonts: [{ fontId: 'Roboto', fontFile: 'Roboto-Regular.ttf' }],
  bgImages: [
    { fileName: WHITE_PAGE, x: 0, y: 0, width: 595.28, height: 841.89 },
    { fileName: 'test.png', x: 470, y: 44, width: 84, height: 84 },
  ],
  images: [],
  shapes: [
    {
      type: 'rect',
      x: 36,
      y: 36,
      width: 523,
      height: 60,
      radius: 6,
      lineWidth: 0,
      fillColor: '#111827',
      strokeColor: '#111827',
    },
    { type: 'line', x: 36, y: 130, toX: 559, toY: 130, lineWidth: 1, strokeColor: '#9ca3af' },
    {
      type: 'circle',
      x: 520,
      y: 190,
      radius: 16,
      lineWidth: 1,
      fillColor: '#e5e7eb',
      strokeColor: '#6b7280',
    },
  ],
  labels: [
    { text: 'SERVICE REQUEST', x: 52, y: 55, type: 'string', fontSize: 18, color: '#ffffff' },
    { text: 'Driver', x: 36, y: 150, type: 'string', fontSize: 9, color: '#6b7280' },
    { text: 'Vehicle', x: 36, y: 196, type: 'string', fontSize: 9, color: '#6b7280' },
    { text: 'VIN', x: 36, y: 242, type: 'string', fontSize: 9, color: '#6b7280' },
  ],
  data: [
    { name: 'fname', x: 36, y: 162, type: 'string', format: 'ucase', fontSize: 14, color: '#111827' },
    { name: 'lname', x: 110, y: 162, type: 'string', format: 'ucase', fontSize: 14, color: '#111827' },
    { name: 'year', x: 36, y: 208, type: 'string', fontSize: 12, color: '#111827' },
    { name: 'make', x: 110, y: 208, type: 'string', fontSize: 12, color: '#111827' },
    {
      name: 'vin',
      x: 36,
      y: 254,
      type: 'string',
      format: 'ucase',
      fontSize: 12,
      font: 'Roboto',
      color: '#111827',
    },
  ],
};
const testData = {
  year: '2022',
  make: 'chev',
  vin: '1gfvh6yhg68909876',
  fname: 'dandre',
  lname: 'gregory',
};

await upsertRecord(
  TOKEN,
  'templates',
  'docName',
  DOC_NAME,
  {
    docName: DOC_NAME,
    doc: JSON.stringify([templatePage]),
    testData: JSON.stringify(testData),
    userId: user.id,
  },
  null,
);

console.log(`
Ready.

  PocketBase admin : ${PB}/_/
  App API key      : ${API_KEY}
  Template docName : ${DOC_NAME}
  Seeded user      : ${USER_EMAIL} (record ${user.id})

Run the app:
  ./scripts/dev-local.sh

Then:
  curl -X POST http://localhost:8080/token/${API_KEY} \\
    -H 'Content-Type: application/json' \\
    -d '{"tempId":"${DOC_NAME}","data":{"year":"2024","make":"ford","vin":"1ftfw1e5xjfa00000","fname":"dandre","lname":"gregory"}}'

  curl -o out.pdf http://localhost:8080/pdf/${DOC_NAME}/<token-from-previous-call>

  curl -o preview.pdf "http://localhost:8080/pdf-test/${DOC_NAME}/${USER_APIKEY}"
`);
