"""Rebuild backend/src/core/services/fonts: the Noto fonts article PDFs embed (#1729).

Downloads each upstream font at a pinned revision, checks its SHA-256, drops
the OpenType layout tables (GSUB, GPOS, GDEF), gives every code point a glyph
of its own and pads every glyph record to an even length, then checks the
result's SHA-256. Run from this directory:

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python prepare.py

Why each step: see README.md.
"""

import functools
import hashlib
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import ROUND_XY_TO_GRID, USE_MY_METRICS, Glyph

OUT = Path(__file__).resolve().parents[2] / 'backend' / 'src' / 'core' / 'services' / 'fonts'
NOTO = 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/4cf78353cd1668040ba8efa13029cd910fcdf9e2/fonts'
LGC = 'https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/4bc63d7ebca1faed49c6c685f380ba0abc2c1941'
NPM = 'https://registry.npmjs.org/@expo-google-fonts'

# name: (source URL, member inside a .tgz or None, source SHA-256, output SHA-256)
FONTS = {
    'NotoSans-Regular.ttf': (f'{NOTO}/NotoSans/unhinted/ttf/NotoSans-Regular.ttf', None,
                             'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8',
                             '5ab693e2c8201b5a69000bd663ae12a31d3f278a7a228194b9fb4538dfa79358'),
    'NotoSans-Bold.ttf': (f'{NOTO}/NotoSans/unhinted/ttf/NotoSans-Bold.ttf', None,
                          '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9',
                          'e9da2f271ec7495c7dbd4380a2c4226cc3027d1b5ee452493486e752563a8f02'),
    'NotoSans-Italic.ttf': (f'{NOTO}/NotoSans/unhinted/ttf/NotoSans-Italic.ttf', None,
                            '678288f868807d4d64a6f3b51466871d117d915780381ce9d0ed4b3bcbd06d37',
                            '1406e8b349ff8dd4dd5ebce61a3bbf95f74548e787466dcf1327a4240c9b0a17'),
    'NotoSansMono-Regular.ttf': (f'{NOTO}/NotoSansMono/unhinted/ttf/NotoSansMono-Regular.ttf', None,
                                 '87f8ce0522a6c99b743ee5fc75b4073cfdd575639119672828b7b9944b65b4f4',
                                 'a310eb66b889b071602fcd3e7911a1fb3e2c3cb11133a9467153a2baea1616f8'),
    'NotoSansSC-Regular.ttf': (f'{NPM}/noto-sans-sc/-/noto-sans-sc-0.4.4.tgz', 'package/400Regular/NotoSansSC_400Regular.ttf',
                               'd45f67f0a7c0ca3f256950777ce6a61cc7ce5f9696d02900cbbaac25f8aa7d16',
                               '425b430cc27579448fbf9c3e4d48f023780431eef164c83885606c781e8c8684'),
    'NotoSansKR-Regular.ttf': (f'{NPM}/noto-sans-kr/-/noto-sans-kr-0.4.4.tgz', 'package/400Regular/NotoSansKR_400Regular.ttf',
                               'b4a747e78805bc25b610dcfc3003cb5fb2e2ec034763774b24216ed15889eef4',
                               'f5483c226c23b474c6ae5eb2b73539c643d0430e9e67a99a6721d8983435bb93'),
}
LICENCES = {
    'OFL-NotoSans.txt': (f'{LGC}/OFL.txt', None, 'cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a'),
    'OFL-NotoSansCJK.txt': (f'{NPM}/noto-sans-sc/-/noto-sans-sc-0.4.4.tgz', 'package/LICENSE_FONT',
                            '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9'),
}


@functools.cache
def download(url):
    """The SC package carries a font and the CJK licence: fetch it once."""
    return urllib.request.urlopen(url).read()


def fetch(url, member, sha256):
    data = download(url)
    if member:
        data = tarfile.open(fileobj=io.BytesIO(data)).extractfile(member).read()
    if hashlib.sha256(data).hexdigest() != sha256:
        sys.exit(f'{url} {member or ""}: SHA-256 differs from the pinned source')
    return data


def unshare_glyphs(font):
    """Gives each code point that shares its glyph with a lower one a glyph of
    its own, appended after the existing glyphs: a composite of the shared glyph
    (same outline, unmoved, same metrics), or an empty glyph if it draws nothing.
    Returns how many glyphs it added."""
    claimed = set()
    copies = {}  # code point: (shared glyph, its own glyph)
    for cp, name in sorted(font.getBestCmap().items()):
        if name in claimed:
            copies[cp] = (name, f'cp{cp:04X}')
        claimed.add(name)
    if not copies:
        return 0
    order = font.getGlyphOrder()
    added = [copy for _, copy in copies.values()]
    if set(added) & set(order):
        sys.exit('unshare_glyphs: a new glyph name is taken')
    font.setGlyphOrder(order + added)
    glyf, hmtx, maxp = font['glyf'], font['hmtx'], font['maxp']
    vmtx = font['vmtx'] if 'vmtx' in font else None
    glyph_set = font.getGlyphSet()
    for name, copy in copies.values():
        if glyf[name].numberOfContours == 0:
            glyf[copy] = Glyph()
        else:
            pen = TTGlyphPen(glyph_set)
            pen.addComponent(name, (1, 0, 0, 1, 0, 0))
            glyph = pen.glyph(componentFlags=ROUND_XY_TO_GRID | USE_MY_METRICS)
            glyph.recalcBounds(glyf)
            glyf[copy] = glyph
            points, contours, depth = glyph.getCompositeMaxpValues(glyf)
            maxp.maxCompositePoints = max(maxp.maxCompositePoints, points)
            maxp.maxCompositeContours = max(maxp.maxCompositeContours, contours)
            maxp.maxComponentElements = max(maxp.maxComponentElements, 1)
            maxp.maxComponentDepth = max(maxp.maxComponentDepth, depth)
        hmtx[copy] = hmtx[name]
        if vmtx is not None:
            vmtx[copy] = vmtx[name]
    for table in font['cmap'].tables:
        for cp, (_, copy) in copies.items():
            if cp in table.cmap:
                table.cmap[cp] = copy
    return len(added)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (url, member, sha256) in LICENCES.items():
        (OUT / name).write_bytes(fetch(url, member, sha256))
    for name, (url, member, source_sha256, output_sha256) in FONTS.items():
        font = TTFont(io.BytesIO(fetch(url, member, source_sha256)), recalcBBoxes=False, recalcTimestamp=False)
        for tag in ('GSUB', 'GPOS', 'GDEF'):
            if tag in font:
                del font[tag]
        added = unshare_glyphs(font)
        font['glyf'].padding = 2
        font.save(OUT / name)
        digest = hashlib.sha256((OUT / name).read_bytes()).hexdigest()
        if digest != output_sha256:
            sys.exit(f'{name}: output SHA-256 {digest} differs from the pinned {output_sha256}')
        print(f'{name} {digest} (+{added} glyphs)')


if __name__ == '__main__':
    main()
