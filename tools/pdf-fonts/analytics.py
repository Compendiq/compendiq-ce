"""Publish verified article fonts, exact cmap ranges and small non-CJK delivery shards."""
import hashlib
import json

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.unicodedata import script_extension

FACES = ('NotoSans-Regular', 'NotoSans-Bold', 'NotoSansSC-Regular', 'NotoSansKR-Regular')
LICENCES = ('OFL-NotoSans.txt', 'OFL-NotoSansCJK.txt')
CJK = {'Hani', 'Hira', 'Kana', 'Hang'}
SHARD_SHA = {'NotoSansSC-Regular-nonCJK': '926cb467822563fcfd3b1ed3f27939648c6beecdbbad60fafcf2e12b991cae2b'}


def ranges(points):
    """Flat pairs of inclusive endpoints; binary searched only on Unicode exports."""
    result = []
    for cp in sorted(points):
        if result and cp == result[-1] + 1:
            result[-1] = cp
        else:
            result.extend((cp, cp))
    return result


def publish(source, frontend):
    out = frontend / 'public/fonts/pdf'
    out.mkdir(parents=True, exist_ok=True)
    for name in (*LICENCES, *(face + '.ttf' for face in FACES)):
        (out / name).write_bytes((source / name).read_bytes())
    coverage = {}
    for face in FACES:
        with TTFont(out / (face + '.ttf')) as font:
            coverage[face] = set(font.getBestCmap())

    # A scalar can fall through either style; SC takes precedence over KR.
    served = coverage[FACES[0]] & coverage[FACES[1]]
    for face in FACES[2:]:
        residual = {cp for cp in coverage[face] - served if not script_extension(chr(cp)) & CJK}
        served = served | coverage[face]
        if not residual:
            continue
        shard = face + '-nonCJK'
        with TTFont(out / (face + '.ttf'), recalcTimestamp=False) as font:
            options = subset.Options()
            options.hinting = True
            worker = subset.Subsetter(options=options)
            worker.populate(unicodes=residual)
            worker.subset(font)
            font['glyf'].padding = 2
            font.save(out / (shard + '.ttf'))
        with TTFont(out / (shard + '.ttf')) as font:
            assert set(font.getBestCmap()) == residual
            assert len(set(font.getBestCmap().values())) == len(residual)
            assert all(offset % 2 == 0 for offset in font['loca'])
        coverage[shard] = residual

    manifest = {}
    for face, points in coverage.items():
        sha = hashlib.sha256((out / (face + '.ttf')).read_bytes()).hexdigest()
        if face not in FACES and sha != SHARD_SHA.get(face):
            raise ValueError(f'{face}: verify and pin the generated SHA-256 {sha}')
        manifest[face] = {'sha256': sha, 'ranges': ranges(points)}
    path = frontend / 'src/shared/lib/analytics-font-coverage.json'
    path.write_text(json.dumps(manifest, separators=(',', ':')) + '\n', encoding='utf-8')
