import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../main/native/xml';
import { audioRendition, parseM3u8, pickVariant, segmentIv } from '../main/native/hls';
import { isoDuration, parseMpd } from '../main/native/dash';
import { parseMetalink, strongestHash } from '../main/native/metalink';

test('the XML reader handles namespaces, entities and CDATA, and refuses DOCTYPE', () => {
  const x = parseXml('<?xml version="1.0"?><a:root xmlns:a="x" k="1 &amp; 2"><b>t&lt;1</b><c><![CDATA[<raw>]]></c><d/></a:root>');
  assert.equal(x.name, 'root');
  assert.equal(x.attrs.k, '1 & 2');
  assert.deepEqual(x.children.map((c) => [c.name, c.text]), [['b', 't<1'], ['c', '<raw>'], ['d', '']]);
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), /DOCTYPE/);
  assert.throws(() => parseXml('<a><b></a>'), /Unexpected/);
});

test('HLS master playlists pick the best muxed variant', () => {
  const master = parseM3u8(['#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"', 'hd.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720', 'mid.m3u8'].join('\n'), 'https://cdn.example/v/master.m3u8');
  assert.equal(master.kind, 'master');
  const pick = pickVariant(master.kind === 'master' ? master.variants : [])!;
  assert.equal(pick.variant.uri, 'https://cdn.example/v/mid.m3u8');
  assert.equal(pick.separateAudio, false);
  assert.equal(pickVariant([{ uri: 'a', bandwidth: 1, resolution: '', audioGroup: 'x' }])!.separateAudio, true);
});

test('HLS masters list EXT-X-MEDIA audio renditions and pick the default one', () => {
  const master = parseM3u8(['#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Deutsch",LANGUAGE="de",DEFAULT=NO,URI="audio/de.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="subs/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="inband",NAME="Main",DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"', 'hd.m3u8'].join('\n'), 'https://cdn.example/v/master.m3u8');
  assert.equal(master.kind, 'master');
  if (master.kind !== 'master') return;
  assert.equal(master.variants.length, 2, 'EXT-X-MEDIA lines are not variants');
  assert.equal(master.renditions.length, 4);
  assert.deepEqual(master.renditions[1], { type: 'AUDIO', groupId: 'aud', uri: 'https://cdn.example/v/audio/en.m3u8', name: 'English', language: 'en', isDefault: true });
  assert.equal(master.renditions[3].uri, null);
  assert.equal(audioRendition(master.renditions, 'aud')!.language, 'en');
  assert.equal(audioRendition(master.renditions, 'subs'), null, 'subtitles are not audio');
  assert.equal(audioRendition(master.renditions, 'inband'), null);
  assert.equal(audioRendition(master.renditions, null), null);
  const noDefault = master.renditions.map((r) => ({ ...r, isDefault: false }));
  assert.equal(audioRendition(noDefault, 'aud')!.language, 'de', 'without DEFAULT=YES the first with a URI');
});

test('HLS variant choice: higher bandwidth with fetchable separate audio wins, keeping the best muxed one as fallback', () => {
  const v = (uri: string, bandwidth: number, audioGroup: string | null = null) => ({ uri, bandwidth, resolution: '', audioGroup });
  const r = (groupId: string, uri: string | null, isDefault = true) => ({ type: 'AUDIO', groupId, uri, name: '', language: '', isDefault });
  const variants = [v('low', 100), v('hd', 900, 'aud'), v('mid', 500)];
  // Audio playlist available: take the HD variant, with the muxed one in reserve for non-fMP4 streams.
  let pick = pickVariant(variants, [r('aud', 'a.m3u8')])!;
  assert.deepEqual([pick.variant.uri, pick.audio?.uri, pick.separateAudio, pick.fallback?.uri], ['hd', 'a.m3u8', true, 'mid']);
  // No rendition for the group at all: nothing to fetch, so the best muxed variant.
  pick = pickVariant(variants)!;
  assert.deepEqual([pick.variant.uri, pick.audio, pick.separateAudio], ['mid', null, false]);
  // A group whose renditions have no URI means the audio is inside the variant: it counts as muxed.
  pick = pickVariant(variants, [r('aud', null)])!;
  assert.deepEqual([pick.variant.uri, pick.audio, pick.separateAudio, pick.fallback], ['hd', null, false, null]);
  // Only separate-audio variants: the best one with a playlist, no fallback.
  pick = pickVariant([v('x', 900, 'none'), v('y', 500, 'aud')], [r('aud', 'a.m3u8')])!;
  assert.deepEqual([pick.variant.uri, pick.audio?.uri, pick.fallback], ['y', 'a.m3u8', null]);
  pick = pickVariant([v('x', 900, 'none')])!;
  assert.deepEqual([pick.variant.uri, pick.audio, pick.separateAudio], ['x', null, true]);
  assert.equal(pickVariant([]), null);
});

test('HLS media playlists carry keys, maps, byte ranges and sequence IVs', () => {
  const media = parseM3u8(['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:7', '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXTINF:4.0,', '#EXT-X-BYTERANGE:100@0', 'all.mp4',
    '#EXTINF:4.0,', '#EXT-X-BYTERANGE:50', 'all.mp4',
    '#EXT-X-KEY:METHOD=AES-128,URI="k2.bin",IV=0x0000000000000000000000000000000A', '#EXTINF:2,', 's3.ts', '#EXT-X-ENDLIST'].join('\n'), 'https://h.example/a/b.m3u8');
  assert.equal(media.kind, 'media');
  if (media.kind !== 'media') return;
  assert.equal(media.endList, true);
  assert.deepEqual(media.segments.map((s) => [s.sequence, s.byterange]), [[7, { length: 100, offset: 0 }], [8, { length: 50, offset: 100 }], [9, null]]);
  assert.equal(media.segments[0].map?.uri, 'https://h.example/a/init.mp4');
  assert.equal(media.segments[0].key?.uri, 'https://h.example/a/key.bin');
  assert.equal(segmentIv(media.segments[1]).toString('hex'), '00000000000000000000000000000008');
  assert.equal(segmentIv(media.segments[2]).toString('hex'), '0000000000000000000000000000000a');
  assert.throws(() => parseM3u8('#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd', 'https://h.example/'), /Unsupported/);
  assert.throws(() => parseM3u8('nope', 'https://h.example/'), /EXTM3U/);
});

test('DASH manifests expand templates, timelines and lists', () => {
  assert.equal(isoDuration('PT1H2M3.5S'), 3723.5);
  const mpd = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S"><BaseURL>media/</BaseURL><Period>
    <AdaptationSet contentType="video"><SegmentTemplate media="v-$RepresentationID$-$Number%03d$.m4s" initialization="v-$RepresentationID$-init.mp4" duration="4" timescale="1"/>
      <Representation id="low" bandwidth="100" mimeType="video/mp4"/><Representation id="hi" bandwidth="900" mimeType="video/mp4"/></AdaptationSet>
    <AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="64"><SegmentTemplate media="a-$Time$.m4s" initialization="a-init.mp4" timescale="10">
      <SegmentTimeline><S t="0" d="20" r="1"/><S d="5"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>
  </Period></MPD>`;
  const [video, audio] = parseMpd(mpd, 'https://d.example/x/manifest.mpd');
  assert.equal(video.id, 'hi');
  assert.equal(video.init, 'https://d.example/x/media/v-hi-init.mp4');
  assert.deepEqual(video.segments, ['001', '002', '003'].map((n) => `https://d.example/x/media/v-hi-${n}.m4s`));
  assert.deepEqual(audio.segments, ['0', '20', '40'].map((t) => `https://d.example/x/media/a-${t}.m4s`));
  assert.throws(() => parseMpd('<MPD type="dynamic"><Period/></MPD>', 'https://d.example/'), /Live/);
});

test('Metalink 4 and 3 list mirrors best first and expose the strongest checksum', () => {
  const v4 = parseMetalink(`<metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="../tool.zip"><size>12</size>
    <hash type="md5">aa</hash><hash type="sha-256">ABCD</hash>
    <url priority="2">https://b.example/tool.zip</url><url priority="1">https://a.example/tool.zip</url><url>javascript:alert(1)</url></file></metalink>`);
  assert.deepEqual(v4, [{ name: 'tool.zip', size: 12, hashes: { md5: 'aa', 'sha-256': 'ABCD' }, urls: ['https://a.example/tool.zip', 'https://b.example/tool.zip'] }]);
  assert.deepEqual(strongestHash(v4[0].hashes), { algorithm: 'sha256', hex: 'abcd' });
  const v3 = parseMetalink(`<metalink version="3.0"><files><file name="x.iso"><verification><hash type="sha1">ff</hash></verification>
    <resources><url type="http" preference="10">http://slow.example/x.iso</url><url type="ftp" preference="90">ftp://fast.example/x.iso</url></resources></file></files></metalink>`);
  assert.deepEqual(v3[0].urls, ['ftp://fast.example/x.iso', 'http://slow.example/x.iso']);
});

test('file shares: \\\\server\\share and smb:// become UNC paths; anything odd is refused', async () => {
  const { shareTarget } = await import('../main/native/share');
  assert.equal(shareTarget('\\\\nas\\media\\films'), '\\\\nas\\media\\films');
  assert.equal(shareTarget('smb://nas.local/media/My%20Films/'), '\\\\nas.local\\media\\My Films');
  for (const bad of ['\\\\nas', 'smb://nas/', '\\\\nas\\..\\x', 'smb://nas/a/../b', '\\\\na s\\x', 'smb://nas/a:b', 'https://nas/x', '\\\\nas\\x\\y?z']) {
    assert.equal(shareTarget(bad), null, bad);
  }
});

test('the command bar offers downloads and shares', async () => {
  const { downloadSuggestions } = await import('../main/ipc');
  const label = (t: string) => downloadSuggestions(t)?.map((s) => [s.label, s.action.type]);
  assert.deepEqual(label('download https://cdn.example/show/index.m3u8'), [['Download HLS stream: index.m3u8', 'download']]);
  assert.deepEqual(label('ftp://ftp.example/pub/tool.iso'), [['Download FTP: tool.iso', 'download']]);
  assert.deepEqual(label('download example.com/file.zip'), [['Download file.zip', 'download']]);
  assert.deepEqual(label('\\\\nas\\media'), [['Open in File Explorer', 'open-share']]);
  assert.deepEqual(label('davs://cloud.example/dav/docs/'), [['Download WebDAV: docs (folder)', 'download']]);
  assert.equal(downloadSuggestions('download javascript:alert(1)')?.[0].action.type, 'noop');
  assert.deepEqual(downloadSuggestions('download', 'https://cdn.example/a/index.m3u8')?.map((x) => x.label), ['Download this HLS stream']);
  assert.equal(downloadSuggestions('download', 'https://example.com/')?.[0].action.type, 'noop');
  assert.equal(downloadSuggestions('downloads'), undefined);
  assert.equal(downloadSuggestions('react docs'), undefined);
});
