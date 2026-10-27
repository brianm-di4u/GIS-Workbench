"""Motion-imagery truth: ffprobe stream table and duration, plus the first KLV ST 0601 packets via
klvdata (timestamp, platform and sensor position, frame-centre and corner tags). Feeds c11-fmv
(fmv.klv tag comparison, footprint ≤ 1 m, sync ≤ 33 ms)."""
import json
import subprocess


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)], capture_output=True, text=True, timeout=120)
    j = json.loads(r.stdout or '{}')
    return {
        'duration': float(j.get('format', {}).get('duration', 0) or 0),
        'streams': [{'index': s['index'], 'codec': s.get('codec_name'), 'type': s.get('codec_type'), 'tag': s.get('codec_tag_string'),
                     'w': s.get('width'), 'h': s.get('height'), 'fps': s.get('r_frame_rate')} for s in j.get('streams', [])],
    }


def klv(path, limit=50):
    """Extract the data stream with ffmpeg, then decode ST 0601 local sets with klvdata."""
    import klvdata
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-map', 'd:0', '-c', 'copy', '-f', 'data', '-'], capture_output=True, timeout=300)
    out = []
    for packet in klvdata.StreamParser(r.stdout):
        try:
            md = packet.MetadataList()
        except Exception:  # noqa: BLE001 - damaged packets are expected in edge-case streams
            continue
        out.append({str(k): (v[0], str(v[3])) for k, v in md.items()})
        if len(out) >= limit:
            break
    return {'packets': len(out), 'first': out[:limit]}


def describe(path):
    d = probe(path)
    if any(s['type'] == 'data' for s in d['streams']):
        try:
            d['klv'] = klv(path)
        except Exception as e:  # noqa: BLE001
            d['klv'] = {'error': str(e)}
    return d
