# mxrjup-content

Editorial content of [mxrjup](https://github.com/mxrjup/mxrjup): what the site shows,
kept apart from the code that shows it.

```
data/       one JSON file per collection, served by GET /api/data/<type>
uploads/    editorial media, served at /uploads/<file>
```

The files look like `{"items": [...]}`. They are written by
[Sveltia CMS](https://github.com/sveltia/sveltia-cms) (the back office at `/admin`,
configured in the code repository's `public/admin/config.yml`) and by the Spotify
timeline sync. Editing by hand works too: keep the `items` shape.

A push to `main` is live within seconds - the host checkout of this repository is the
server's `CONTENT_DIR`, and the server rereads the JSON on every request. There is no
build and no tag to cut.

The publishing is `.github/workflows/publish.yml`: on every push to `main` (and when
called by another workflow of this repository, or run by hand) it runs
`git pull --ff-only` in that checkout over SSH. It fails, publishing nothing, if the
checkout has local changes or if its history has diverged from `main` (a commit made
on the host, or `main` rewritten) - fix the checkout by hand, then run it again. It
needs the `INFOMANIAK_HOST`, `INFOMANIAK_USER`, `INFOMANIAK_SSH_KEY` and
`INFOMANIAK_CONTENT_PATH` secrets. A workflow that pushes to `main` with the default
`GITHUB_TOKEN` does not trigger it, so such a workflow calls it itself:

```yaml
  publish:
    needs: <the job that pushed>
    uses: ./.github/workflows/publish.yml
    secrets: inherit
```

What visitors write on the `/computer` page (uploaded files, chat) does **not** belong
here: it lives in the private `mxrjup-visitors` repository.

History before the split comes from the code repository, where these files lived under
`personal-site/server/` and then `server/`.

## Music timeline

`data/timeline.json` is the one list behind `/music/timeline`. It is edited in the CMS,
and `.github/workflows/spotify-timeline.yml` adds the albums saved in Spotify to it every
Monday at 05:17 UTC (or when run by hand from the Actions tab). The sync only ever
**appends**:

- an album is already there when an entry has the same `spotifyId`, or the same title
  once normalized - lower case, accents and punctuation dropped, spaces collapsed, so
  `DMX - It's Dark And Hell Is Hot` and `dmx - its dark and hell is hot` are one album.
  An entry typed by hand, without an id, is enough to keep the Spotify one out;
- an existing entry is never changed or removed: edit a title, a date or a cover
  in the CMS and the sync leaves it that way. An album removed from the Spotify library
  stays on the timeline;
- to take an album off the site, tick **Masquer** in the CMS (`"hidden": true`) instead of deleting
  it - the entry stays in the file, so the sync does not add it back, and the server
  leaves it out of `GET /api/data/timeline`;
- the albums it adds carry `spotifyId`; the file is sorted by `date`, newest first, and
  written as 2-space JSON with a final newline. When nothing is new the file is not
  touched and nothing is committed or published.

The workflow commits as `github-actions[bot]`, pushes to `main`, then calls
`publish.yml` itself. If the CMS pushed in the meantime, it starts again from the new
`main`. If a secret is missing or Spotify answers with an error, it fails without
committing; the next run catches up. Covers are Spotify's CDN URLs (`i.scdn.co`), not
files of this repository.

It needs three secrets, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and
`SPOTIFY_REFRESH_TOKEN`, from a Spotify app (https://developer.spotify.com/dashboard)
whose redirect URI is exactly `http://127.0.0.1:8888/callback`. The refresh token is
minted once, on a machine with a browser:

```bash
node scripts/spotify-timeline.mjs --print-refresh-token --client-id=<id> --client-secret=<secret>
```

Run by hand, `node scripts/spotify-timeline.mjs --client-id=<id>` logs in through the
browser instead and updates `data/timeline.json` the same way; add `--download` to
store the covers of the added albums in `uploads/` rather than point at the CDN - then
commit `uploads/` too. `node --test 'scripts/test/*.test.mjs'` runs the tests (Node 22
or later, no install); they also run on every pull request that touches `scripts/`.
