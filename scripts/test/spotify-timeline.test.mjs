// The whole routine against a fake Spotify: the real fetch is swapped for one that
// answers the token and saved-albums endpoints, so nothing leaves the machine.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncTimeline, toTimelineItems } from '../spotify-timeline.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'spotify-timeline.mjs');
const realFetch = globalThis.fetch;

const saved = (id, name, artist, addedAt, releaseDate = '2001') => ({
    added_at: `${addedAt}T12:00:00Z`,
    album: {
        id,
        name,
        artists: [{ name: artist }],
        release_date: releaseDate,
        images: [{ url: `https://i.scdn.co/image/${id}-640` }, { url: `https://i.scdn.co/image/${id}-64` }]
    }
});

/** A fake Spotify serving `library` in pages of two; `fail` breaks one endpoint. */
function fakeSpotify(library, { fail } = {}) {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(String(input));
        calls.push(url.href);
        const json = (status, body) => new Response(JSON.stringify(body), {
            status, headers: { 'Content-Type': 'application/json' }
        });

        if (url.href === 'https://accounts.spotify.com/api/token') {
            if (fail === 'token') return json(400, { error: 'invalid_grant' });
            const body = new URLSearchParams(String(init.body));
            assert.equal(body.get('grant_type'), 'refresh_token');
            assert.equal(body.get('refresh_token'), 'refresh');
            assert.equal(init.headers.Authorization, 'Basic ' + Buffer.from('id:secret').toString('base64'));
            return json(200, { access_token: 'access' });
        }
        if (url.origin + url.pathname === 'https://api.spotify.com/v1/me/albums') {
            assert.equal(init.headers.Authorization, 'Bearer access');
            const offset = Number(url.searchParams.get('offset') || 0);
            if (fail === 'second-page' && offset > 0) return json(502, { error: 'bad gateway' });
            const next = offset + 2 < library.length
                ? `https://api.spotify.com/v1/me/albums?limit=50&offset=${offset + 2}`
                : null;
            return json(200, { items: library.slice(offset, offset + 2), total: library.length, next });
        }
        throw new Error(`unexpected request to ${url.href}`);
    };
    return calls;
}

let dir;
let file;
const options = () => ({
    file, clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh',
    download: false, uploadsDir: path.join(dir, 'uploads')
});

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spotify-timeline-'));
    file = path.join(dir, 'timeline.json');
});
afterEach(async () => {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
});

// What the CMS would have written: a manual entry, one edited Spotify entry, one hidden.
const CMS_FILE = JSON.stringify({
    items: [
        {
            title: 'Portishead - Dummy (first pressing)',
            date: '2024-02-01',
            releaseDate: '1994-08-22',
            cover: '/uploads/dummy.jpg',
            spotifyId: 'dummy',
            hidden: false
        },
        { title: "DMX - It's Dark And Hell Is Hot", date: '2023-11-11', cover: '/uploads/dmx.jpg' },
        { title: 'Nickelback - Silver Side Up', date: '2022-01-01', spotifyId: 'nb', hidden: true },
        { title: 'Gone - From The Library', date: '2021-01-01', spotifyId: 'gone' }
    ]
}, null, 2) + '\n';

const LIBRARY = [
    saved('new2', 'Selected Ambient Works 85-92', 'Aphex Twin', '2025-03-01', '1992-02-12'),
    saved('dummy', 'Dummy', 'Portishead', '2024-02-01', '1994-08'),
    saved('dmx-spotify', 'It’s Dark and Hell Is Hot', 'DMX', '2024-01-05', '1998-05-19'),
    saved('nb', 'Silver Side Up', 'Nickelback', '2022-01-01'),
    saved('new1', 'Homogenic', 'Björk', '2023-12-24', '1997')
];

test('the first run fills an empty timeline from the whole library', async () => {
    await writeFile(file, '{\n  "items": []\n}\n');
    fakeSpotify(LIBRARY);
    const added = await syncTimeline(options());
    assert.equal(added.length, 5);

    const text = await readFile(file, 'utf8');
    assert.ok(text.endsWith('}\n'));
    const { items } = JSON.parse(text);
    assert.deepEqual(items[0], {
        title: 'Aphex Twin - Selected Ambient Works 85-92',
        date: '2025-03-01',
        releaseDate: '1992-02-12',
        cover: 'https://i.scdn.co/image/new2-640',
        spotifyId: 'new2'
    });
    assert.deepEqual(items.map((item) => item.date),
        ['2025-03-01', '2024-02-01', '2024-01-05', '2023-12-24', '2022-01-01']);
});

test('a run on a CMS-edited file only appends, and a second run changes nothing', async () => {
    await writeFile(file, CMS_FILE);
    const calls = fakeSpotify(LIBRARY);
    const added = await syncTimeline(options());
    assert.ok(calls.length >= 4, 'token plus three pages');

    assert.deepEqual(added.map((item) => item.spotifyId), ['new2', 'new1']);
    const after = await readFile(file, 'utf8');
    const { items } = JSON.parse(after);
    const before = JSON.parse(CMS_FILE).items;
    // Every entry that was there is still there, unchanged, key order included.
    for (const entry of before) {
        assert.ok(items.some((item) => JSON.stringify(item) === JSON.stringify(entry)), entry.title);
    }
    assert.equal(items.length, before.length + 2);
    assert.deepEqual(items.map((item) => item.date),
        ['2025-03-01', '2024-02-01', '2023-12-24', '2023-11-11', '2022-01-01', '2021-01-01']);

    const { mtimeMs } = await stat(file);
    fakeSpotify(LIBRARY);
    assert.deepEqual(await syncTimeline(options()), []);
    assert.equal(await readFile(file, 'utf8'), after);
    assert.equal((await stat(file)).mtimeMs, mtimeMs, 'the file is not even rewritten');
});

test('nothing new leaves the file byte for byte, even if the CMS formatted it differently', async () => {
    const unsorted = '{"items":[{"title":"Portishead - Dummy","date":"2020-01-01"},'
        + '{"title":"Later","date":"2024-01-01"}]}';
    await writeFile(file, unsorted);
    fakeSpotify([saved('dummy', 'Dummy', 'Portishead', '2024-02-01')]);
    assert.deepEqual(await syncTimeline(options()), []);
    assert.equal(await readFile(file, 'utf8'), unsorted);
});

for (const [fail, message] of [['token', /Token request failed: 400/], ['second-page', /failed: 502/]]) {
    test(`a Spotify error (${fail}) fails the run and leaves the file alone`, async () => {
        await writeFile(file, CMS_FILE);
        fakeSpotify(LIBRARY, { fail });
        await assert.rejects(syncTimeline(options()), message);
        assert.equal(await readFile(file, 'utf8'), CMS_FILE);
        assert.deepEqual(await readdir(dir), ['timeline.json'], 'no temporary file left behind');
    });
}

test('a broken timeline file is refused before Spotify is called', async () => {
    await writeFile(file, '{"items": [');
    const calls = fakeSpotify(LIBRARY);
    await assert.rejects(syncTimeline(options()), SyntaxError);
    assert.deepEqual(calls, []);
    assert.equal(await readFile(file, 'utf8'), '{"items": [');
});

test('--unattended without the secrets exits with an error and writes nothing', () => {
    const env = { ...process.env };
    delete env.SPOTIFY_CLIENT_ID;
    delete env.SPOTIFY_CLIENT_SECRET;
    delete env.SPOTIFY_REFRESH_TOKEN;

    for (const extra of [{}, { SPOTIFY_CLIENT_ID: 'id' }, { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 's' }]) {
        const run = spawnSync(process.execPath, [SCRIPT, '--unattended', `--file=${file}`], {
            env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000
        });
        assert.equal(run.status, 1, run.stderr);
        assert.match(run.stderr, /Missing --client-id|--unattended needs/);
    }
});

test('toTimelineItems keeps the existing shape and adds spotifyId', () => {
    assert.deepEqual(toTimelineItems([saved('x', 'Name', 'Artist', '2020-02-02', '1975-03')]), [{
        title: 'Artist - Name',
        date: '2020-02-02',
        releaseDate: '1975-03-01',
        cover: 'https://i.scdn.co/image/x-640',
        spotifyId: 'x'
    }]);
});
