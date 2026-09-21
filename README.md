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
