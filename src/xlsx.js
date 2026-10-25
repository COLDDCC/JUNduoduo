// 极简 .xlsx 生成器：不依赖任何库，Worker 和 Node 都能跑。
// 支持：多个工作表、文字/数字单元格、列宽、行高、超链接、嵌入图片（JPEG/PNG/GIF）。

const enc = new TextEncoder();
const xml = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const colName = (i) => {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

// ---------- 图片 ----------
/** 识别图片格式和像素尺寸；不认识的格式返回 null（Excel 不支持 webp） */
export function imageInfo(bytes) {
  const b = bytes;
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { ext: 'png', mime: 'image/png', w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { ext: 'gif', mime: 'image/gif', w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      // SOF0..SOF15（除去 DHT/JPG/DAC）里有尺寸
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { ext: 'jpeg', mime: 'image/jpeg', h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + len;
    }
    return { ext: 'jpeg', mime: 'image/jpeg', w: 100, h: 100 };
  }
  return null;
}

// ---------- ZIP（不压缩） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 文件名
    lv.setUint16(8, 0, true); // 不压缩
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cenSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

// ---------- 工作簿 ----------
const EMU = 9525; // 1 像素

/**
 * sheets: [{
 *   name, cols: [宽度(字符)], rowHeight: 数据行行高(磅，可空),
 *   rows: [[单元格...]]，单元格可为 string / number / null / { v, link } / { image: Uint8Array }
 *   第一行按表头加粗
 * }]
 * 返回 Uint8Array（.xlsx 文件内容）
 */
export function buildXlsx(sheets) {
  const files = [];
  const media = [];
  const ctOverrides = [];
  const sheetEntries = [];

  sheets.forEach((sh, si) => {
    const n = si + 1;
    const rels = [];
    const links = [];
    const anchors = [];
    const rowsXml = sh.rows
      .map((row, ri) => {
        const r = ri + 1;
        const ht = ri > 0 && sh.rowHeight ? ` ht="${sh.rowHeight}" customHeight="1"` : '';
        const cells = (row || [])
          .map((c, ci) => {
            const ref = `${colName(ci)}${r}`;
            const style = ri === 0 ? 1 : 2;
            if (c == null || c === '') return `<c r="${ref}" s="${style}"/>`;
            if (c && typeof c === 'object' && c.image) {
              const info = imageInfo(c.image);
              if (!info) return c.fallback ? `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${xml(c.fallback)}</t></is></c>` : `<c r="${ref}" s="${style}"/>`;
              media.push({ ...info, data: c.image });
              const box = c.size || 80;
              const scale = Math.min(box / info.w, box / info.h, 1) || 1;
              anchors.push({ col: ci, row: ri, idx: media.length, w: Math.round(info.w * scale), h: Math.round(info.h * scale) });
              return `<c r="${ref}" s="${style}"/>`;
            }
            if (typeof c === 'number') return `<c r="${ref}" s="${style}"><v>${c}</v></c>`;
            if (typeof c === 'object' && c.link) {
              const rid = `rId${rels.length + 1}`;
              rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(c.link)}" TargetMode="External"/>`);
              links.push(`<hyperlink ref="${ref}" r:id="${rid}"/>`);
              return `<c r="${ref}" s="3" t="inlineStr"><is><t>${xml(c.v ?? c.link)}</t></is></c>`;
            }
            return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(c)}</t></is></c>`;
          })
          .join('');
        return `<row r="${r}"${ht}>${cells}</row>`;
      })
      .join('');

    let drawingTag = '';
    if (anchors.length) {
      const drid = `rId${rels.length + 1}`;
      rels.push(`<Relationship Id="${drid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n}.xml"/>`);
      drawingTag = `<drawing r:id="${drid}"/>`;
      const drels = [];
      const pics = anchors
        .map((a, k) => {
          const m = media[a.idx - 1];
          drels.push(`<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${a.idx}.${m.ext}"/>`);
          return `<xdr:oneCellAnchor><xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>${4 * EMU}</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>${4 * EMU}</xdr:rowOff></xdr:from><xdr:ext cx="${a.w * EMU}" cy="${a.h * EMU}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${k + 2}" name="Picture ${k + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${k + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${a.w * EMU}" cy="${a.h * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
        })
        .join('');
      files.push({
        name: `xl/drawings/drawing${n}.xml`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pics}</xdr:wsDr>`,
      });
      files.push({
        name: `xl/drawings/_rels/drawing${n}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drels.join('')}</Relationships>`,
      });
      ctOverrides.push(`<Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    }

    const cols = (sh.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    files.push({
      name: `xl/worksheets/sheet${n}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rowsXml}</sheetData>${links.length ? `<hyperlinks>${links.join('')}</hyperlinks>` : ''}<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>${drawingTag}</worksheet>`,
    });
    if (rels.length) {
      files.push({
        name: `xl/worksheets/_rels/sheet${n}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
      });
    }
    ctOverrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    sheetEntries.push({ n, name: String(sh.name || `Sheet${n}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) });
  });

  media.forEach((m, i) => files.push({ name: `xl/media/image${i + 1}.${m.ext}`, data: m.data }));
  const exts = [...new Set(media.map((m) => m.ext))];

  files.unshift(
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.map((e) => `<Default Extension="${e}" ContentType="${media.find((m) => m.ext === e).mime}"/>`).join('')}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${ctOverrides.join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries.map((s) => `<sheet name="${xml(s.name)}" sheetId="${s.n}" r:id="rId${s.n}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetEntries.map((s) => `<Relationship Id="rId${s.n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.n}.xml"/>`).join('')}<Relationship Id="rId${sheetEntries.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      // 0 默认 / 1 表头加粗灰底 / 2 正文垂直居中自动换行 / 3 超链接
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD0D0D0"/></left><right style="thin"><color rgb="FFD0D0D0"/></right><top style="thin"><color rgb="FFD0D0D0"/></top><bottom style="thin"><color rgb="FFD0D0D0"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    },
  );
  return zip(files);
}
