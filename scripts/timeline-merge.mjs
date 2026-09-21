/**
 * Merge the saved Spotify albums into data/timeline.json - add only.
 *
 * The file is also edited by hand in the CMS, so the sync must never undo an edit:
 * it appends the albums the file does not know yet and leaves every existing entry
 * exactly as it is, down to its key order. That also means:
 *
 *   - an album removed from the Spotify library stays on the timeline;
 *   - an entry marked `hidden: true` stays in the file - which is what keeps it from
 *     being added again - and the server leaves it out of GET /api/data/timeline.
 *     Hiding is how an album still in the library is taken off the site.
 *
 * An album is already known when an entry has the same `spotifyId`, or the same
 * title once normalized (see normalizeTitle). The title match is what recognizes an
 * album that was entered by hand, without an id, before the sync found it.
 */

/**
 * Reduce a title to what identifies the album: lower case, accents dropped (NFKD
 * then the combining marks removed), punctuation removed, whitespace collapsed.
 * "DMX - It's Dark And Hell Is Hot" and "dmx - its dark and hell is hot" are one.
 */
export function normalizeTitle(title) {
    return String(title ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/\p{P}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Newest first. Plain code-point comparison, so the order never depends on a locale. */
function byDateDesc(a, b) {
    const da = String(a.date ?? '');
    const db = String(b.date ?? '');
    return da < db ? 1 : da > db ? -1 : 0;
}

/**
 * Return the timeline with the albums in `incoming` that it lacks, and which ones
 * those were. `existing` entries are returned as the same objects, unchanged.
 * Nothing added means `items` is `existing` itself, untouched and unsorted, so the
 * caller can leave the file alone.
 */
export function mergeTimeline(existing, incoming) {
    const ids = new Set();
    const titles = new Set();
    const remember = (item) => {
        if (item.spotifyId) ids.add(String(item.spotifyId));
        const key = normalizeTitle(item.title);
        // An untitled entry must not swallow every other untitled one.
        if (key) titles.add(key);
    };
    existing.forEach(remember);

    const added = [];
    for (const item of incoming) {
        const known = (item.spotifyId && ids.has(String(item.spotifyId)))
            || titles.has(normalizeTitle(item.title));
        if (known) continue;
        added.push(item);
        // The library can hold the same record twice (a reissue under the same name);
        // the timeline tracks entries by title, so only the first one goes in.
        remember(item);
    }

    if (added.length === 0) return { items: existing, added };
    // Array.prototype.sort is stable: entries sharing a date keep their order, so
    // sorting an already sorted file is a no-op and a second run changes nothing.
    return { items: [...existing, ...added].sort(byDateDesc), added };
}

/**
 * Parse the timeline file. Accept the CMS shape ({"items": [...]}) and a bare
 * array, and keep any other top-level key on the way back out.
 */
export function parseTimeline(text) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { doc: {}, items: parsed };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items ?? [])) {
        throw new Error('The timeline file is neither {"items": [...]} nor an array.');
    }
    return { doc: parsed, items: parsed.items ?? [] };
}

/** Two-space JSON with a final newline - the CMS's own output, so diffs stay small. */
export function serializeTimeline(doc, items) {
    return JSON.stringify({ ...doc, items }, null, 2) + '\n';
}
