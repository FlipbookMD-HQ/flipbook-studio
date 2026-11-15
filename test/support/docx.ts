import { crc32, deflateRawSync } from "node:zlib";

// Builds small .docx files for tests (US-18): the OOXML parts mammoth needs, zipped by hand.

export interface ZipFile {
  name: string;
  data: Buffer;
  /** Pretend the entry expands to this many bytes (zip-bomb tests). */
  declaredSize?: number;
}

export function zip(files: ZipFile[], { deflate = true } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const body = deflate ? deflateRawSync(file.data) : file.data;
    const method = deflate ? 8 : 0;
    const crc = crc32(file.data);
    const size = file.declaredSize ?? file.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const docx = {
  heading: (level: number, text: string) =>
    `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${esc(text)}</w:t></w:r></w:p>`,
  para: (text: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`,
  bold: (text: string) => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(text)}</w:t></w:r></w:p>`,
  bullet: (text: string) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${esc(text)}</w:t></w:r></w:p>`,
  table: (rows: string[][]) =>
    `<w:tbl>${rows
      .map(
        (row) =>
          `<w:tr>${row.map((cell) => `<w:tc><w:p><w:r><w:t>${esc(cell)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`,
      )
      .join("")}</w:tbl>`,
  /** An image run; `rel` is the relationship ID, `link` makes it an external (not embedded) image. */
  image: (rel: string, alt: string, link = false) =>
    `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture" descr="${esc(alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip ${link ? "r:link" : "r:embed"}="${rel}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
};

export interface DocxImage {
  rel: string;
  file: string;
  data: Buffer;
}

export function buildDocx({
  body,
  images = [],
  links = [],
  title,
}: {
  body: string;
  images?: DocxImage[];
  links?: { rel: string; target: string }[];
  title?: string;
}): Buffer {
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="emf" ContentType="image/x-emf"/><Default Extension="tiff" ContentType="image/tiff"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${images
    .map(
      (image) =>
        `<Relationship Id="${image.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.file}"/>`,
    )
    .join("")}${links
    .map(
      (link) =>
        `<Relationship Id="${link.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${esc(link.target)}" TargetMode="External"/>`,
    )
    .join("")}</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${NS}>${[1, 2, 3, 4]
    .map(
      (level) =>
        `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/></w:style>`,
    )
    .join("")}</w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const document = `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}><w:body>${body}</w:body></w:document>`;
  const core = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${title ? `<dc:title>${esc(title)}</dc:title>` : ""}</cp:coreProperties>`;
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(types) },
    { name: "_rels/.rels", data: Buffer.from(rootRels) },
    { name: "word/document.xml", data: Buffer.from(document) },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(docRels) },
    { name: "word/styles.xml", data: Buffer.from(styles) },
    { name: "word/numbering.xml", data: Buffer.from(numbering) },
    { name: "docProps/core.xml", data: Buffer.from(core) },
    ...images.map((image) => ({ name: `word/media/${image.file}`, data: image.data })),
  ]);
}

/** A tiny valid PNG header (40×30), enough for the D19 check and imageSize. */
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 40, 0, 0, 0, 30, 8, 6, 0, 0, 0]),
]);
