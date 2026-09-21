#!/usr/bin/env node
/**
 * Export your saved Spotify albums into server/data/timeline_spotify.json.
 *
 *   node scripts/spotify-timeline.mjs --client-id=<id> [--download] [--out=path]
 *
 * Reads GET /v1/me/albums, which returns the album plus `added_at` - the date
 * you saved it, which the timeline groups by - and `release_date`, which each
 * entry carries as well, so a card shows both when you found a record and when
 * it came out.
 *
 * The file this writes is NOT versioned: it belongs to the host, which refreshes
 * it from cron (scripts/spotify-cron.sh). Albums added by hand in the CMS live in
 * server/data/timeline.json, which is versioned; the server serves the two merged.
 *
 * Two ways in:
 *
 *   Interactive (a laptop) - Authorization Code + PKCE. Your browser logs in to
 *   Spotify directly and this script only ever sees the resulting token. No
 *   password goes through it, and nothing is stored on disk.
 *
 *   Unattended (cron) - a refresh token, minted once with
 *   `--print-refresh-token` and kept in server/.env as SPOTIFY_REFRESH_TOKEN.
 *   That path needs the client secret; in exchange the token is stable, where a
 *   PKCE refresh token rotates on every use and would have to be written back.
 *
 * Setup, once:
 *   1. https://developer.spotify.com/dashboard -> Create app
 *   2. Add redirect URI exactly: http://127.0.0.1:8888/callback
 *      (127.0.0.1, not localhost - Spotify rejects localhost)
 *   3. Copy the Client ID into --client-id, and for cron the Client Secret into
 *      SPOTIFY_CLIENT_SECRET, then run:
 *      node scripts/spotify-timeline.mjs --print-refresh-token
 *
 * Covers default to Spotify's CDN URL, which keeps several hundred images out
 * of a repository that is already large. --download fetches them into
 * server/uploads/ instead, at the cost of committing every one of them - not
 * something to do from cron, which would re-fetch them on every run.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPE = 'user-library-read';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

/**
 * Map Spotify's saved-album objects onto the timeline's shape.
 * The timeline stores no artist, so it goes in the title - which also keeps
 * titles unique, since the template tracks entries by title.
 */
export function toTimelineItems(savedAlbums) {
    return savedAlbums
        .filter((saved) => saved?.album)
        .map(({ added_at, album }) => ({
            title: `${(album.artists || []).map((a) => a.name).join(', ')} - ${album.name}`.replace(/^ - /, ''),
            date: String(added_at).slice(0, 10),
            releaseDate: normalizeReleaseDate(album.release_date),
            // images are ordered widest first
            cover: album.images?.[0]?.url ?? ''
        }))
        .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Spotify dates carry their own precision: "1975", "1975-03" or "1975-03-04".
 * Pad to a full date so DatePipe and the CMS datetime widget both accept them.
 * The card shows only the year, so a padded day is never displayed as fact.
 */
export function normalizeReleaseDate(date) {
    const parts = String(date || '').split('-');
    // No usable year: return nothing, so the card omits the line rather than
    // claiming the record came out in the year 0.
    if (!/^\d{4}$/.test(parts[0])) return '';
    return [parts[0], parts[1] || '01', parts[2] || '01'].join('-');
}

/** Open the login page in whatever the platform's default browser is. */
function openBrowser(url) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

/** Serve the redirect URI once and resolve with the code Spotify sends back. */
function waitForCode(authUrl) {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const { searchParams } = new URL(req.url, REDIRECT_URI);
            const received = searchParams.get('code');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<p>${received ? 'Done - you can close this tab.' : 'No code received.'}</p>`);
            server.close();
            received ? resolve(received) : reject(new Error(searchParams.get('error') || 'No code returned'));
        });
        server.listen(8888, '127.0.0.1', () => {
            console.log('Opening Spotify login in your browser...');
            console.log(`If it does not open, go to:\n${authUrl}\n`);
            openBrowser(authUrl.toString());
        });
    });
}

/** Build the /authorize URL; `extra` carries whichever flow's parameters. */
function authorizeUrl(clientId, extra) {
    const url = new URL('https://accounts.spotify.com/authorize');
    url.search = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        ...extra
    }).toString();
    return url;
}

async function postToken(body, headers = {}) {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(body)
    });
    if (!response.ok) throw new Error(`Token request failed: ${response.status} ${await response.text()}`);
    return response.json();
}

const basicAuth = (clientId, clientSecret) =>
    ({ Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64') });

/** Run the PKCE dance and resolve with an access token. No secret needed. */
async function authorizePkce(clientId) {
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());

    const code = await waitForCode(authorizeUrl(clientId, {
        code_challenge_method: 'S256',
        code_challenge: challenge
    }));

    const token = await postToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier
    });
    return token.access_token;
}

/**
 * Plain Authorization Code flow, which needs the secret and in return hands back
 * a refresh token that does not rotate - the one thing cron can live on.
 * Run once by hand; the result goes in server/.env.
 */
async function authorizeForRefreshToken(clientId, clientSecret) {
    const code = await waitForCode(authorizeUrl(clientId, {}));
    return postToken(
        { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI },
        basicAuth(clientId, clientSecret)
    );
}

/** Trade the stored refresh token for a fresh access token - the cron path. */
async function tokenFromRefresh(clientId, clientSecret, refreshToken) {
    const token = await postToken(
        { grant_type: 'refresh_token', refresh_token: refreshToken },
        basicAuth(clientId, clientSecret)
    );
    return token.access_token;
}

/** Page through the whole saved-albums library, 50 at a time. */
async function fetchSavedAlbums(token) {
    let url = 'https://api.spotify.com/v1/me/albums?limit=50';
    const all = [];

    while (url) {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

        if (response.status === 429) {
            const wait = Number(response.headers.get('retry-after') || 2);
            console.log(`Rate limited, waiting ${wait}s...`);
            await new Promise((r) => setTimeout(r, wait * 1000));
            continue;
        }
        if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);

        const page = await response.json();
        all.push(...page.items);
        console.log(`  ${all.length}/${page.total}`);
        url = page.next;
    }
    return all;
}

/** Fetch every cover into server/uploads/ and rewrite the items to point at it. */
async function downloadCovers(items, uploadsDir) {
    await mkdir(uploadsDir, { recursive: true });

    for (const [i, item] of items.entries()) {
        if (!item.cover) continue;
        const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        const name = `album-${slug || i}.jpg`;

        const response = await fetch(item.cover);
        if (!response.ok) {
            console.warn(`  could not download cover for ${item.title} (${response.status}), keeping the CDN URL`);
            continue;
        }
        await writeFile(path.join(uploadsDir, name), Buffer.from(await response.arrayBuffer()));
        item.cover = `/uploads/${name}`;
        console.log(`  ${i + 1}/${items.length} ${name}`);
    }
    return items;
}

async function main() {
    const args = Object.fromEntries(
        process.argv.slice(2).map((a) => {
            const [k, v] = a.replace(/^--/, '').split('=');
            return [k, v ?? true];
        })
    );

    const clientId = args['client-id'] || process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = args['client-secret'] || process.env.SPOTIFY_CLIENT_SECRET;
    const refreshToken = args['refresh-token'] || process.env.SPOTIFY_REFRESH_TOKEN;

    if (!clientId) {
        console.error('Missing --client-id=<id> (or SPOTIFY_CLIENT_ID).');
        console.error('Create an app at https://developer.spotify.com/dashboard with redirect URI');
        console.error(`  ${REDIRECT_URI}`);
        process.exit(1);
    }

    // Mint the credential cron runs on, then stop - this writes no timeline.
    if (args['print-refresh-token']) {
        if (!clientSecret) {
            console.error('Missing --client-secret=<secret> (or SPOTIFY_CLIENT_SECRET).');
            console.error('Dashboard -> your app -> Settings -> View client secret.');
            process.exit(1);
        }
        const token = await authorizeForRefreshToken(clientId, clientSecret);
        console.log('\nAdd this line to server/.env on the host:\n');
        console.log(`SPOTIFY_REFRESH_TOKEN=${token.refresh_token}`);
        console.log('\nIt does not expire. Treat it like a password: it reads your Spotify library.');
        return;
    }

    if (refreshToken && !clientSecret) {
        console.error('SPOTIFY_REFRESH_TOKEN is set but SPOTIFY_CLIENT_SECRET is not - refreshing needs both.');
        process.exit(1);
    }

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const out = args.out ? path.resolve(args.out) : path.join(root, 'server/data/timeline_spotify.json');

    const token = refreshToken
        ? await tokenFromRefresh(clientId, clientSecret, refreshToken)
        : await authorizePkce(clientId);

    console.log('Fetching saved albums...');
    const saved = await fetchSavedAlbums(token);

    let items = toTimelineItems(saved);
    if (args.download) {
        console.log('Downloading covers...');
        items = await downloadCovers(items, path.join(root, 'server/uploads'));
    }

    // The running server reads this file on every request, so swap it in with a
    // rename - a half-written file is never served, and a failed run changes nothing.
    await writeFile(`${out}.tmp`, JSON.stringify({ items }, null, 2) + '\n');
    await rename(`${out}.tmp`, out);

    console.log(`\nWrote ${items.length} albums to ${out}`);
    console.log(items.length ? `Newest: ${items[0].date} - oldest: ${items[items.length - 1].date}` : '');
}

// Only run when executed directly, so the mapping stays importable for tests.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}
