"""Explicit, read-only refresh of the five approved regression snapshots."""
import hashlib
import json
import pathlib
import re
import shutil
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPECS = [
    ('xian', 'c7d39d86', ['mixed-lodging', 'homestay', 'distance-limit', 'manual-cover', 'open-jaw']),
    ('chaoshan', 'a5485da4', ['cross-city', 'poi-removal', 'library-cover']),
    ('luzhou', '8e88090b', ['group-tour', 'shared-car', 'traffic-disabled']),
    ('chengdu', 'f07535eb', ['free-travel', 'no-car']),
    ('rikaze', '49ecb537', ['private-tour', 'four-diamond', 'poi-alternatives', 'train-only']),
]


def sanitize(value):
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()
                if not re.search(r'cookie|token|password|authorization|phone|mobile|accountKey|ownerUserId', k, re.I)}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    if isinstance(value, str):
        return re.sub(r'(?<!\d)1[3-9]\d{9}(?!\d)', '[手机号已移除]', value)
    return value


def compose(plan, evidence):
    product = json.loads(json.dumps(plan))
    for field in evidence.get('fields', []):
        target = product
        for key in field['path'][:-1]:
            target = target[int(key)] if isinstance(target, list) else target.setdefault(key, {})
        key = field['path'][-1]
        if isinstance(target, list):
            target[int(key)] = field['value']
        else:
            target[key] = field['value']
    return product


def main():
    if len(sys.argv) != 2:
        raise SystemExit('用法：python3 scripts/product-regression/export.py /absolute/path/vbk-desktop.sqlite')
    source = pathlib.Path(sys.argv[1]).resolve()
    db = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
    out = ROOT / 'test/fixtures/product-regression'
    out.mkdir(parents=True, exist_ok=True)
    for key, prefix, tags in SPECS:
        rows = db.execute('SELECT id,name,created_at,updated_at,product_json FROM products WHERE id LIKE ?', (prefix + '%',)).fetchall()
        if len(rows) != 1:
            raise ValueError(f'{key} 来源不唯一或不存在')
        rid, name, created, updated, raw = rows[0]
        row = db.execute('SELECT payload_json FROM product_resource_evidence WHERE local_product_id=?', (rid,)).fetchone()
        if not row:
            raise ValueError(f'{key} 缺少独立资源证据')
        evidence = json.loads(row[0])
        p = sanitize(compose(json.loads(raw), evidence))
        p['basicInfo']['supplierProductCode'] = 'REGRESSION-' + key.upper()
        if 'bookingControls' in p.get('operations', {}):
            p['operations']['bookingControls']['butler'] = {'contactCardId': 1, 'providerId': 1, 'displayName': '测试管家'}
        messages = [{'id': f'user-{i}', 'role': 'user', 'content': sanitize(content), 'createdAt': stamp}
                    for i, (content, stamp) in enumerate(db.execute("SELECT content,created_at FROM messages WHERE local_product_id=? AND role='user' ORDER BY created_at", (rid,)))]
        research = [{'id': f'research-{i}', 'label': label, 'type': kind, 'status': status, 'state': state,
                     'detail': sanitize(detail), 'evidence': sanitize(json.loads(raw_evidence))}
                    for i, (label, kind, status, state, detail, raw_evidence) in enumerate(db.execute(
                        'SELECT label,type,status,state,detail,evidence_json FROM research_tasks WHERE local_product_id=? ORDER BY id', (rid,)))]
        pois = []
        for day in p['itinerary']:
            for spot in day.get('spots', []):
                if not spot.get('poiId') or spot.get('kind', 'attraction') != 'attraction':
                    continue
                av = db.execute('SELECT status,open_status,lately_open_time,verified_at FROM ctrip_poi_availability_cache WHERE poi_id=?', (spot['poiId'],)).fetchone()
                if not av:
                    raise ValueError(f'{key} 缺少 POI 营业证据：{spot["name"]}')
                pois.append({'day': day['day'], 'keyword': spot['name'], 'candidate': spot,
                             'availability': dict(zip(['status', 'openStatus', 'latelyOpenTime', 'verifiedAt'], av))})
        asset = None
        cover = p['presentation']['cover']
        if cover['source'] == 'manualUpload':
            file_id = cover['fileId']
            matches = list((source.parent / 'covers' / file_id[:2]).glob(file_id + '.*'))
            if len(matches) != 1:
                raise ValueError(f'{key} 手动封面文件缺失')
            target = out / f'{key}-cover{matches[0].suffix}'
            shutil.copyfile(matches[0], target)
            asset = {'file': target.name, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
        snapshot = {'version': 1, 'key': key, 'sourceId': rid, 'name': name, 'tags': tags,
                    'recordedAt': updated, 'createdAt': created,
                    'provenance': 'persisted-business-query-projections; not raw HTTP recordings',
                    'product': p, 'resourceEvidence': sanitize(evidence), 'messages': messages,
                    'researchTasks': research, 'poiReplay': pois, 'manualAsset': asset,
                    'modelReplay': {'content': '请按已保存方案核验资源，完成后仅请求审批。'}}
        # Compact each top-level field: readable modules, comfortably below 350 lines.
        lines = ['{'] + ['  ' + json.dumps(k) + ': ' + json.dumps(v, ensure_ascii=False, separators=(',', ':')) + (',' if i < len(snapshot)-1 else '')
                         for i, (k, v) in enumerate(snapshot.items())] + ['}']
        (out / f'{key}.json').write_text('\n'.join(lines) + '\n')
        print(f'{key}: {rid} / {len(pois)} POI projections')
    db.close()


if __name__ == '__main__':
    main()
