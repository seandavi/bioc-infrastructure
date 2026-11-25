// PACKAGES.rds without R: a gzip-compressed R serialization of a character matrix.
// Layout verified against tools::write_PACKAGES() output: XDR, version 3, native encoding
// "UTF-8", attributes dim then dimnames, row names = the Package column.
// Version 3 (R >= 3.5) because that is what R itself writes today; v2 would also load but
// differs from the files R clients already get from CRAN and Bioconductor.

const enc = new TextEncoder();
const NIL = 0xfe; // NILVALUE_SXP
const CHARSXP = 9;
const ASCII = 0x40000; // gp bit 6 (ASCII_MASK) << 12
const UTF8 = 0x8000; // gp bit 3 (UTF8_MASK) << 12

class Out {
  buf = new Uint8Array(1 << 16);
  view = new DataView(this.buf.buffer);
  n = 0;
  private room(k: number) {
    if (this.n + k <= this.buf.length) return;
    const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    bigger.set(this.buf);
    this.buf = bigger;
    this.view = new DataView(bigger.buffer);
  }
  int(v: number) {
    this.room(4);
    this.view.setInt32(this.n, v);
    this.n += 4;
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  str(s: string | null) {
    if (s === null) return this.int(CHARSXP), this.int(-1);
    const b = enc.encode(s);
    this.int(CHARSXP | (b.length === s.length ? ASCII : UTF8));
    this.int(b.length);
    this.bytes(b);
  }
  strsxp(v: (string | null)[]) {
    this.int(0x10);
    this.int(v.length);
    for (const s of v) this.str(s);
  }
  tag(name: string) {
    this.int(0x402); // LISTSXP with a tag
    this.int(1); // SYMSXP
    this.str(name);
  }
}

// The uncompressed serialization (XDR) of a character matrix. null is NA_character_.
export function serializeCharacterMatrix(
  rows: (string | null)[][], colnames: string[], rownames?: string[] | null,
): Uint8Array {
  const nc = colnames.length;
  for (const r of rows) if (r.length !== nc) throw new Error("row length differs from colnames");
  if (rownames && rownames.length !== rows.length) throw new Error("rownames length differs from rows");
  const o = new Out();
  o.bytes(new Uint8Array([0x58, 0x0a])); // "X\n": XDR
  o.int(3);
  o.int(0x040000); // written by R 4.0.0
  o.int(0x030500); // readable by R >= 3.5.0
  const native = enc.encode("UTF-8");
  o.int(native.length);
  o.bytes(native);
  o.int(0x210);
  o.int(rows.length * nc);
  for (let j = 0; j < nc; j++) for (const r of rows) o.str(r[j]); // column-major
  o.tag("dim");
  o.int(13); // INTSXP
  o.int(2);
  o.int(rows.length);
  o.int(nc);
  o.tag("dimnames");
  o.int(0x13); // VECSXP
  o.int(2);
  if (rownames) o.strsxp(rownames);
  else o.int(NIL);
  o.strsxp(colnames);
  o.int(NIL); // end of attributes
  return o.buf.slice(0, o.n);
}

// PACKAGES.rds for these records: one row per record, one column per field, in the order given;
// a field a record lacks is NA. Returns the gzip-compressed file bytes.
export async function packagesRds(
  records: Record<string, string | undefined>[], fields: readonly string[],
): Promise<Uint8Array> {
  const rows = records.map((r) => fields.map((f) => r[f] ?? null));
  const rownames = records.length ? records.map((r) => r.Package ?? "") : null; // write_PACKAGES writes none for 0 rows
  const raw = serializeCharacterMatrix(rows, [...fields], rownames);
  const gz = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(gz).arrayBuffer());
}
