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
from itertools import groupby
from pathlib import Path

from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import ROUND_XY_TO_GRID, USE_MY_METRICS, Glyph
from fontTools.unicodedata import script

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
    'NotoSansArmenian-Regular.ttf': (f'{NOTO}/NotoSansArmenian/unhinted/ttf/NotoSansArmenian-Regular.ttf', None,
                                     '73bde9f3c63aa5ed39236e8a2837224605210a98b54d65724676c0119fcaa24c',
                                     '8e98cf1d43a2d0a3c4e441c0bbde03d020657a4bf128bcbb9626144db73d5d6f'),
    'NotoSansGeorgian-Regular.ttf': (f'{NOTO}/NotoSansGeorgian/unhinted/ttf/NotoSansGeorgian-Regular.ttf', None,
                                     'f4b229b126859725b75031dd8c051335d20c85e4eb6d525af28f3e83e471baa4',
                                     'e169a8db0d9b6cabf27ec216218efcc9072b0411f3a241b19f879e6ec7db6b99'),
    'NotoSansSymbols-Regular.ttf': (f'{NOTO}/NotoSansSymbols/unhinted/ttf/NotoSansSymbols-Regular.ttf', None,
                                    '6eea9cb4cd39269ea9f95ba5c2735f80ae74049dfc9e1a7c932a5cfc8f0c3030',
                                    '89d855b68d7fb77dac12502c63e2f57f9aaa70a56ef72298cfe1d1e5fd7b86f4'),
    'NotoSansSymbols2-Regular.ttf': (f'{NOTO}/NotoSansSymbols2/unhinted/ttf/NotoSansSymbols2-Regular.ttf', None,
                                     'c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d',
                                     '3d40f2bd8248922aa48cf84bcc0a92a09987fbb26216c2177ad4cff43c9fa557'),
}
LICENCES = {
    'OFL-NotoSans.txt': (f'{LGC}/OFL.txt', None, 'cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a'),
    'OFL-NotoSansCJK.txt': (f'{NPM}/noto-sans-sc/-/noto-sans-sc-0.4.4.tgz', 'package/LICENSE_FONT',
                            '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9'),
    'OFL-NotoSansArmenian.txt': ('https://raw.githubusercontent.com/notofonts/armenian/3d3807b9702aa9d6441b2dce49af2b29e47872af/OFL.txt',
                                 None, '0468358b316f69f405b55cadf8a8314e16e3610b8feaad96772bd5d968112d02'),
    'OFL-NotoSansGeorgian.txt': ('https://raw.githubusercontent.com/notofonts/georgian/ac0c3432fd0a6b36d052d4c29af60d197dfc00a3/OFL.txt',
                                 None, 'e3f4adf9f719071caae93301fac75384cb8ea075968d0d60565a0732eb08996b'),
    'OFL-NotoSansSymbols.txt': ('https://raw.githubusercontent.com/notofonts/symbols/c42cbaee99cb13013814864f8081d8c18656ec02/OFL.txt',
                                None, 'b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0'),
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


def write_fallback_ranges():
    """Exact residual cmaps in drawing order, so preflight need not open optional files."""
    def cmap(name):
        with TTFont(OUT / f'{name}.ttf') as font:
            return set(font.getBestCmap())

    # Every style tries Mono, or (in code) Regular. A scalar missing in even
    # one sans style can reach fallback unless Mono has it.
    claimed = cmap('NotoSansMono-Regular') | set.intersection(
        *(cmap(f'NotoSans-{style}') for style in ('Regular', 'Bold', 'Italic')))
    lines = ['// Generated by tools/pdf-fonts/prepare.py; do not edit.', 'export const FALLBACK_RANGES = [']
    for family in ('SC', 'KR', 'Armenian', 'Georgian', 'Symbols', 'Symbols2'):
        name = f'NotoSans{family}-Regular'
        remaining = cmap(name) - claimed
        if family in ('Symbols', 'Symbols2'):
            # These fonts also have Rumi numerals (Arabic script) and combining
            # marks. A cmap entry does not give pdf-lib bidi or positioning.
            remaining = {cp for cp in remaining if script(chr(cp)) in {'Zyyy', 'Latn', 'Grek', 'Brai'}}
        claimed.update(remaining)
        ranges = []
        for _, run in groupby(enumerate(sorted(remaining)), key=lambda pair: pair[1] - pair[0]):
            points = [f'\\u{{{cp:x}}}' for _, cp in run]
            ranges.append(points[0] if len(points) == 1 else f'{points[0]}-{points[-1]}')
        lines.append(f"  ['{name}', String.raw`{''.join(ranges)}`],")
    lines.append('] as const;')
    (OUT.parent / 'pdf-fallback-ranges.ts').write_text('\n'.join(lines) + '\n', encoding='utf-8')


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
    write_fallback_ranges()


if __name__ == '__main__':
    main()
