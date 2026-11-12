"""Rebuild backend/src/core/services/fonts: the Noto fonts article PDFs embed (#1729).

Downloads each upstream font at a pinned revision, checks its SHA-256, drops
the OpenType layout tables (GSUB, GPOS, GDEF) and pads every glyph record to
an even length, then checks the result's SHA-256. Run from this directory:

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

from fontTools.ttLib import TTFont

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
                               'a1d6b7087d48357b2d39e5f219a249de6de8e4589f49d36d4f297dabb1037f82'),
    'NotoSansKR-Regular.ttf': (f'{NPM}/noto-sans-kr/-/noto-sans-kr-0.4.4.tgz', 'package/400Regular/NotoSansKR_400Regular.ttf',
                               'b4a747e78805bc25b610dcfc3003cb5fb2e2ec034763774b24216ed15889eef4',
                               'daf7bec6cb059242d8a84da4f65417aec5dfd427816390c203a5765808706c46'),
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


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (url, member, sha256) in LICENCES.items():
        (OUT / name).write_bytes(fetch(url, member, sha256))
    for name, (url, member, source_sha256, output_sha256) in FONTS.items():
        font = TTFont(io.BytesIO(fetch(url, member, source_sha256)), recalcBBoxes=False, recalcTimestamp=False)
        for tag in ('GSUB', 'GPOS', 'GDEF'):
            if tag in font:
                del font[tag]
        font['glyf'].padding = 2
        font.save(OUT / name)
        digest = hashlib.sha256((OUT / name).read_bytes()).hexdigest()
        if digest != output_sha256:
            sys.exit(f'{name}: output SHA-256 {digest} differs from the pinned {output_sha256}')
        print(f'{name} {digest}')


if __name__ == '__main__':
    main()
