import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeTitle,
    mergeTimeline,
    parseTimeline,
    serializeTimeline
} from '../timeline-merge.mjs';

const album = (title, date, spotifyId, extra = {}) =>
    ({ title, date, releaseDate: '', cover: `https://i.scdn.co/${spotifyId}`, spotifyId, ...extra });

test('normalizeTitle folds case, accents, punctuation and spacing', () => {
    assert.equal(
        normalizeTitle("DMX - It's Dark And Hell Is Hot"),
        normalizeTitle('dmx - its dark and hell is hot')
    );
    assert.equal(normalizeTitle('  Björk -  Homogénic '), 'bjork homogenic');
    assert.equal(normalizeTitle('Beyoncé — Lemonade!'), 'beyonce lemonade');
    assert.equal(normalizeTitle('Sigur Rós – ( )'), 'sigur ros');
    assert.equal(normalizeTitle(undefined), '');
});

test('an album whose spotifyId is already there is not added, whatever its title', () => {
    const existing = [album('Renamed by hand', '2024-01-01', 'id1')];
    const { items, added } = mergeTimeline(existing, [album('Artist - Original', '2024-01-01', 'id1')]);
    assert.deepEqual(added, []);
    assert.equal(items, existing);
});

test('title variants of an existing album are duplicates', () => {
    const existing = [album("DMX - It's Dark And Hell Is Hot", '2020-05-01', 'dmx')];
    const incoming = [
        album('dmx - its dark and hell is hot', '2021-01-01', 'other-id'),
        album('DMX – It’s Dark and Hell Is Hot', '2021-01-01', 'third-id'),
        album('  DMX -  ITS DARK AND HELL IS HOT!!', '2021-01-01', 'fourth-id')
    ];
    const { items, added } = mergeTimeline(existing, incoming);
    assert.deepEqual(added, []);
    assert.equal(items, existing);
});

test('a manual entry without spotifyId blocks the Spotify album with an equivalent title', () => {
    const manual = { title: 'Björk - Homogénic', date: '2019-03-02', cover: '/uploads/homogenic.jpg' };
    const { items, added } = mergeTimeline([manual], [album('Bjork - Homogenic', '2023-01-01', 'bjork')]);
    assert.deepEqual(added, []);
    assert.equal(items.length, 1);
    assert.equal(items[0], manual);
    // No id is written onto the manual entry either.
    assert.equal('spotifyId' in manual, false);
});

test('an entry edited by hand is kept exactly as it is, key order included', () => {
    const edited = {
        cover: '/uploads/custom.jpg',
        title: 'Artist - Album (my notes)',
        date: '2018-07-07',
        spotifyId: 'id1',
        note: 'a field the sync knows nothing about'
    };
    const before = JSON.stringify(edited);
    const { items } = mergeTimeline([edited], [
        album('Artist - Album', '2024-02-02', 'id1'),
        album('Someone - New', '2024-03-03', 'id2')
    ]);
    const kept = items.find((item) => item.spotifyId === 'id1');
    assert.equal(kept, edited);
    assert.equal(JSON.stringify(kept), before);
});

test('a hidden entry is never added again', () => {
    const hidden = { ...album('Artist - Hidden', '2022-01-01', 'id1'), hidden: true };
    const hiddenManual = { title: 'Other - Gone', date: '2022-01-01', hidden: true };
    const { items, added } = mergeTimeline([hidden, hiddenManual], [
        album('Artist - Hidden', '2022-01-01', 'id1'),
        album('other - gone', '2022-01-01', 'id9')
    ]);
    assert.deepEqual(added, []);
    assert.deepEqual(items, [hidden, hiddenManual]);
});

test('an album gone from Spotify stays on the timeline', () => {
    const gone = album('Artist - Removed From Library', '2020-01-01', 'gone');
    const { items, added } = mergeTimeline([gone], [album('Artist - Still There', '2021-01-01', 'kept')]);
    assert.equal(added.length, 1);
    assert.ok(items.includes(gone));
    assert.equal(mergeTimeline([gone], []).items[0], gone);
});

test('new albums are added with their spotifyId and the result is sorted newest first', () => {
    const existing = [
        { title: 'Old manual', date: '2019-01-01' },
        { title: 'Undated manual' }
    ];
    const { items, added } = mergeTimeline(existing, [
        album('B - Newest', '2025-06-01', 'b'),
        album('A - Middle', '2022-06-01', 'a')
    ]);
    assert.deepEqual(added.map((item) => item.spotifyId), ['b', 'a']);
    assert.deepEqual(items.map((item) => item.title),
        ['B - Newest', 'A - Middle', 'Old manual', 'Undated manual']);
});

test('the same record twice in the library is added once', () => {
    const { added } = mergeTimeline([], [
        album('Artist - Album', '2024-01-02', 'x1'),
        album('Artist - Album', '2024-01-01', 'x2')
    ]);
    assert.deepEqual(added.map((item) => item.spotifyId), ['x1']);
});

test('a second pass with the same library changes nothing, byte for byte', () => {
    const library = [
        album('C - Same Day 1', '2024-05-05', 'c1'),
        album('C - Same Day 2', '2024-05-05', 'c2'),
        album('D - Earlier', '2023-01-01', 'd')
    ];
    const start = parseTimeline('{\n  "items": [\n    { "title": "Manual", "date": "2024-05-05" }\n  ]\n}\n');
    const first = mergeTimeline(start.items, library);
    const firstText = serializeTimeline(start.doc, first.items);

    const again = parseTimeline(firstText);
    const second = mergeTimeline(again.items, library);
    assert.deepEqual(second.added, []);
    assert.equal(second.items, again.items);
    assert.equal(serializeTimeline(again.doc, second.items), firstText);
});

test('the file is written with 2-space indentation and a final newline, other keys kept', () => {
    const { doc, items } = parseTimeline('{"note":"kept","items":[{"title":"A","date":"2020-01-01"}]}');
    assert.equal(
        serializeTimeline(doc, items),
        '{\n  "note": "kept",\n  "items": [\n    {\n      "title": "A",\n      "date": "2020-01-01"\n    }\n  ]\n}\n'
    );
    // A bare array (the server accepts one too) comes back in the CMS shape.
    assert.deepEqual(parseTimeline('[{"title":"A"}]'), { doc: {}, items: [{ title: 'A' }] });
    assert.throws(() => parseTimeline('{"items": {}}'));
    assert.throws(() => parseTimeline('not json'));
});
