"""Build the Google-Docs-shaped .docx importer fixtures in this directory.

These mirror the package and paragraph structure of real worldbuilding
notes exported from Google Docs (no Heading styles anywhere, direct run
formatting, tab-indented outlines, numPr lists, a comment), with every
name and sentence replaced by invented placeholder text.

Stdlib only, fixed timestamps, so the output is byte-for-byte reproducible:

    python3 -I api/tests/fixtures/ingest/docx-gdocs/build_gdocs.py

Used by api/tests/ingest-docx-gdocs-fixtures.test.ts.
"""

import os
import zipfile
from xml.sax.saxutils import escape

OUT = os.path.dirname(os.path.abspath(__file__))
STAMP = (2020, 1, 1, 0, 0, 0)

NS = (
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
)
RSID = ('w:rsidR="00000000" w:rsidDel="00000000" w:rsidP="00000000" '
        'w:rsidRDefault="00000000" w:rsidRPr="00000000"')
RUN_RSID = 'w:rsidDel="00000000" w:rsidR="00000000" w:rsidRPr="00000000"'
HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

STYLES = (
    HEAD + f'<w:styles {NS}><w:docDefaults><w:rPrDefault><w:rPr>'
    '<w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/>'
    '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en"/></w:rPr></w:rPrDefault>'
    '<w:pPrDefault><w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr>'
    '</w:pPrDefault></w:docDefaults>'
    '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="normal"/></w:style>'
    '<w:style w:type="table" w:styleId="TableNormal" w:default="1"><w:name w:val="Table Normal"/></w:style>'
    + ''.join(
        f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/>'
        '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext w:val="1"/>'
        f'<w:keepLines w:val="1"/></w:pPr><w:rPr><w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>'
        '</w:rPr></w:style>'
        for n, sz in ((1, 40), (2, 32), (3, 28))
    )
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>'
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:sz w:val="52"/>'
    '<w:szCs w:val="52"/></w:rPr></w:style></w:styles>'
)


def _lvl(ilvl, fmt, text):
    return (f'<w:lvl w:ilvl="{ilvl}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/>'
            f'<w:lvlText w:val="{text}"/><w:lvlJc w:val="left"/><w:pPr>'
            f'<w:ind w:left="{720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>'
            '<w:rPr><w:u w:val="none"/></w:rPr></w:lvl>')


NUMBERING = (
    HEAD + f'<w:numbering {NS}>'
    '<w:abstractNum w:abstractNumId="1">'
    + _lvl(0, 'decimal', '%1.') + _lvl(1, 'lowerLetter', '%2.') + _lvl(2, 'lowerRoman', '%3.')
    + '</w:abstractNum><w:abstractNum w:abstractNumId="2">'
    + _lvl(0, 'bullet', '●') + _lvl(1, 'bullet', '○') + _lvl(2, 'bullet', '■')
    + '</w:abstractNum>'
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>'
    '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>'
)

SETTINGS = (HEAD + f'<w:settings {NS}><w:defaultTabStop w:val="720"/><w:compat>'
            '<w:compatSetting w:val="15" w:name="compatibilityMode" '
            'w:uri="http://schemas.microsoft.com/office/word"/></w:compat></w:settings>')
FONTS = HEAD + f'<w:fonts {NS}><w:font w:name="Arial"/></w:fonts>'

REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
CT_BASE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.'

SECT = ('<w:sectPr><w:pgSz w:h="15840" w:w="12240"/><w:pgMar w:bottom="1440" '
        'w:top="1440" w:left="1440" w:right="1440" w:header="720" w:footer="720"/>'
        '<w:pgNumType w:start="1"/></w:sectPr>')


def t(text):
    return f'<w:t xml:space="preserve">{escape(text)}</w:t>'


def r(text='', *, b=False, i=False, u=False, sz=None, tabs=0, br=False):
    rpr = ''
    if b:
        rpr += '<w:b w:val="1"/>'
    if i:
        rpr += '<w:i w:val="1"/>'
    if sz:
        rpr += f'<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>'
    if u:
        rpr += '<w:u w:val="single"/>'
    rpr += '<w:rtl w:val="0"/>'
    body = ('<w:br w:type="textWrapping"/>' if br else '') + '<w:tab/>' * tabs
    if text:
        body += t(text)
    return f'<w:r {RUN_RSID}><w:rPr>{rpr}</w:rPr>{body}</w:r>'


class Doc:
    def __init__(self):
        self.paras = []

    def p(self, *runs, ppr=''):
        pid = f'{len(self.paras) + 1:08X}'
        self.paras.append(f'<w:p {RSID} w14:paraId="{pid}"><w:pPr>{ppr}<w:rPr/></w:pPr>'
                          + ''.join(runs) + '</w:p>')

    def xml(self):
        return HEAD + f'<w:document {NS}><w:body>' + ''.join(self.paras) + SECT + '</w:body></w:document>'


def write_package(name, document_xml, extra_parts=()):
    parts = [
        ('word/document.xml', 'document.main+xml', None),
        ('word/styles.xml', 'styles+xml', 'styles'),
        ('word/settings.xml', 'settings+xml', 'settings'),
        ('word/fontTable.xml', 'fontTable+xml', 'fontTable'),
        ('word/numbering.xml', 'numbering+xml', 'numbering'),
        *extra_parts,
    ]
    content = {
        'word/document.xml': document_xml, 'word/styles.xml': STYLES,
        'word/settings.xml': SETTINGS, 'word/fontTable.xml': FONTS,
        'word/numbering.xml': NUMBERING,
    }
    overrides = ''.join(f'<Override ContentType="{CT_BASE}{ct}" PartName="/{p}"/>'
                        for p, ct, _ in parts)
    rels = ''.join(f'<Relationship Id="rId{n}" Type="{REL_BASE}{rel}" Target="{p[5:]}"/>'
                   for n, (p, _, rel) in enumerate((x for x in parts if x[2]), start=1))
    files = [
        ('[Content_Types].xml', HEAD + '<Types xmlns="http://schemas.openxmlformats.org/'
         'package/2006/content-types"><Default ContentType="application/vnd.openxmlformats-'
         'package.relationships+xml" Extension="rels"/><Default ContentType="application/xml" '
         f'Extension="xml"/>{overrides}</Types>'),
        ('_rels/.rels', HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/'
         f'2006/relationships"><Relationship Id="rId1" Type="{REL_BASE}officeDocument" '
         'Target="word/document.xml"/></Relationships>'),
        ('word/_rels/document.xml.rels', HEAD + '<Relationships xmlns="http://schemas.'
         f'openxmlformats.org/package/2006/relationships">{rels}</Relationships>'),
    ]
    for p, _, _ in parts:
        files.append((p, content.get(p) or dict(extra_contents)[p]))
    path = os.path.join(OUT, name)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for fname, data in files:
            info = zipfile.ZipInfo(fname, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data.encode('utf-8'))
    print('wrote', path)


extra_contents = []

# ── 1. pantheon-tabs.docx ────────────────────────────────────────────────────
# A family tree kept as plain paragraphs: depth is expressed ONLY by leading
# <w:tab/> runs or a first-line indent, never by a list. Top-level names are
# bold+underlined runs followed by an unformatted "(epithet)" run.
pan = Doc()
pan.p(r('Ostra', b=True, u=True, sz=24), r(' (Founder;Keeper of the Upper Ford)'))
pan.p(r(tabs=1), r('Vell ', b=True, u=True), r('(', u=True), r('Keeper of Hours)'))
FL = '<w:ind w:firstLine="720"/>'
pan.p(r('Dorn ', b=True, u=True), r('(Keeper of Distance)'), ppr=FL)
pan.p(r('Ilsa ', b=True, u=True), r('(Keeper of Order)'), ppr=FL)
pan.p(r('Pell (Keeper of Making)', tabs=2))
pan.p(r('Quen (Keeper of Chance) ', tabs=2))
pan.p(r('Tamsin ', b=True, u=True), r('(Keeper of Records and ink)'), ppr=FL)
pan.p(r('Corvane (Keeper of Wants; Lord of the Under-Market)', tabs=2))
pan.p(r('Hesk (Keeper of Bridges; The Old Ferryman)', tabs=3))
pan.p(r('Ferries ', tabs=3))
pan.p(r('Brannoch: (Keeper of Reason)'))
pan.p(r('Liss (Keeper of Ardour)'))
pan.p(r('{Brannoch||Liss}: Mereth(Keeper of Thought)', tabs=1))
pan.p(r('Folk', tabs=3))
pan.p(r('Gath’Orrin', tabs=3))
pan.p(r('Ruvane ', b=True, u=True), r('(Keeper of Endings) '), ppr=FL)
pan.p(r('Selk (Keeper of Fog)', tabs=2))
write_package('pantheon-tabs.docx', pan.xml())

# ── 2. ranked-orders.docx ────────────────────────────────────────────────────
# Two lists: a decimal "Name: description" ranking (numId 1) and a chapter
# outline of plain "Chapter N" lines each followed by bullets (numId 2), with
# a nested bullet. An empty header part is referenced, as Docs exports do.
LIST = ('<w:numPr><w:ilvl w:val="{lvl}"/><w:numId w:val="{num}"/></w:numPr>'
        '<w:ind w:left="{left}" w:hanging="360"/>')


def li(doc, text, num, lvl=0):
    doc.p(r(text), ppr=LIST.format(lvl=lvl, num=num, left=720 * (lvl + 1)))


ro = Doc()
for line in (
    'Guild Masters: Sit on the river council and set the toll for every lock. A seat '
    'passes to an heir only with the council’s vote. ',
    'Lock Wardens: Four of them, one for each lock between the quarry and the sea.',
    'The Weigher & The Tallyman: One weighs every barge at the first lock; '
    'the other records the weight and the fee in the long ledger.',
    'Pilots: Licensed to steer through the narrows in Spring, Summer, Autumn and '
    'Winter.  An unlicensed barge pays double.',
    'Bargemen: Crew a single boat; most own a share in it.',
    'Porters: Paid by the load and answerable to a Lock Warden.',
):
    li(ro, line, 1)
ro.p(r(''))
for chapter, bullets in (
    ('Chapter 1 ', ['Open at the quarry lock ', 'Show the toll board',
                    'A barge arrives overweight ']),
    ('Chapter 2', ['Meet the tallyman', ('Dispute over the scales', 1),
                   'Ride the flood downstream']),
):
    ro.p(r(chapter))
    for b in bullets:
        if isinstance(b, tuple):
            li(ro, b[0], 2, b[1])
        else:
            li(ro, b, 2)

header = HEAD + f'<w:hdr {NS}><w:p {RSID}><w:pPr><w:rPr/></w:pPr></w:p></w:hdr>'
extra_contents.append(('word/header1.xml', header))
ro_xml = ro.xml().replace(
    '<w:sectPr>', '<w:sectPr><w:headerReference r:id="rId5" w:type="default"/>')
write_package('ranked-orders.docx', ro_xml,
              extra_parts=[('word/header1.xml', 'header+xml', 'header')])

# ── 3. chronicle.docx ────────────────────────────────────────────────────────
# Era headings that are only bold+underlined, centred, size-12 paragraphs (no
# Heading style: the heuristic must find them), long indented prose, a soft
# break + tab paragraph opener, a dated timeline block, a bold opening quote
# mark followed by plain text, and one reviewer comment.
ch = Doc()
PROSE = '<w:spacing w:line="360" w:lineRule="auto"/><w:ind w:firstLine="720"/>'
HEADING = PROSE + '<w:jc w:val="center"/>'


def era(title):
    ch.p(r(title, b=True, u=True, sz=24), ppr=HEADING)


era('The Quiet Era')
ch.p(r('The river town began as six huts beside a ford. Stone from the hill quarry '
       'went down to the coast on rafts, and the huts grew into a market, then a '
       'walled town with a stone bridge. ', sz=24), ppr=PROSE)
ch.p(r('', sz=24), ppr=PROSE)
ch.p(r('Two families ran the ford: one counted the rafts and one repaired the banks. '
       'For three generations nothing much else happened.', sz=24),
     ppr=PROSE)
era('The Era of Wardens')
ch.p(r('Wardens were appointed to every lock; each kept a ledger of what passed and what '
       'was turned back.', sz=24, br=True, tabs=1), ppr=PROSE)
ch.p(r('1,200 BC/0: The first raft crosses the ford ', sz=24))
ch.p(r('950 B.C: The stone bridge is finished', sz=24))
ch.p(r('640 BC: The toll ledger is lost in a flood ', sz=24))
ch.p(r('1. This line only looks like a list item; it is a plain paragraph.', sz=24))
era('The Long Argument')
ch.p(r('“', b=True, sz=24),
     r('Who pays the toll this year?” said the clerk.', sz=24), ppr=PROSE)
ch.p('<w:commentRangeStart w:id="0"/>' + r('The council voted to rebuild the second lock.', sz=24)
     + '<w:commentRangeEnd w:id="0"/>'
     + f'<w:r {RUN_RSID}><w:commentReference w:id="0"/></w:r>', ppr=PROSE)
comments = (HEAD + f'<w:comments {NS}><w:comment w:author="Reviewer" w:id="0" '
            'w:date="2020-01-01T00:00:00Z"><w:p><w:r><w:t>Check this date.</w:t></w:r>'
            '</w:p></w:comment></w:comments>')
extra_contents.append(('word/comments.xml', comments))
write_package('chronicle.docx', ch.xml(),
              extra_parts=[('word/comments.xml', 'comments+xml', 'comments')])
