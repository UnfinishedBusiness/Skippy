const Tool = require('../tool_prototype');
const fs   = require('fs');
const path = require('path');

class PdfTool extends Tool {
  async run(args) {
    const logger = global.logger || console;

    // Normalize args — accept object, single-element array containing object, or positional array
    if (Array.isArray(args)) {
      if (args.length === 1 && typeof args[0] === 'object') {
        args = args[0];
      } else {
        args = { action: args[0], filepath: args[1] };
      }
    }

    const action = (args.action || '').toLowerCase();
    logger.info(`PdfTool: action="${action}" filepath="${args.filepath || args.output || ''}"`);

    try {
      switch (action) {
        case 'read':     return await this._read(args);
        case 'write':    return await this._write(args);
        case 'merge':    return await this._merge(args);
        case 'add_page': return await this._addPage(args);
        default:
          return { error: `Unknown action: "${action}". Valid actions: read, write, merge, add_page`, exitCode: 1 };
      }
    } catch (err) {
      logger.error(`PdfTool: ${action} failed: ${err.message}`);
      return { error: err.message, exitCode: 1 };
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async _read(args) {
    const { PDFParse } = require('pdf-parse');
    const absPath = path.resolve(args.filepath);
    const url     = 'file://' + absPath;
    const parser  = new PDFParse({ url });
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo(),
    ]);
    await parser.destroy();
    return {
      filepath:  absPath,
      text:      textResult.text,
      num_pages: infoResult.total,
      info:      infoResult.info || {},
      error:     null,
      exitCode:  0,
    };
  }

  // ── Write (create new PDF) ────────────────────────────────────────────────

  async _write(args) {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const absPath  = path.resolve(args.filepath);
    const fontSize = args.font_size || 12;
    const margin   = args.margin   || 50;

    const pdfDoc   = await PDFDocument.create();
    const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Support two input formats:
    //   pages: [{ text, title }, ...]  — explicit pages
    //   content: "string"              — auto page-break on overflow
    if (args.pages && Array.isArray(args.pages)) {
      for (const pageSpec of args.pages) {
        const page       = pdfDoc.addPage();
        const { width, height } = page.getSize();
        let y = height - margin;

        if (pageSpec.title) {
          page.drawText(pageSpec.title, { x: margin, y, size: fontSize + 4, font: boldFont });
          y -= (fontSize + 4) * 1.8;
        }
        this._drawWrappedText(page, font, pageSpec.text || '', margin, y, width - margin * 2, fontSize);
      }
    } else {
      // Auto page-break mode
      const text = args.content || args.text || '';
      let remaining = text;
      while (remaining.length > 0) {
        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();
        remaining = this._drawWrappedText(page, font, remaining, margin, height - margin, width - margin * 2, fontSize);
      }
      if (pdfDoc.getPageCount() === 0) pdfDoc.addPage(); // always at least one page
    }

    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(absPath, pdfBytes);
    return { filepath: absPath, num_pages: pdfDoc.getPageCount(), error: null, exitCode: 0 };
  }

  // ── Merge ─────────────────────────────────────────────────────────────────

  async _merge(args) {
    const { PDFDocument } = require('pdf-lib');
    const files  = args.files || [];
    const output = path.resolve(args.output || args.filepath);

    const merged = await PDFDocument.create();
    for (const f of files) {
      const bytes  = fs.readFileSync(path.resolve(f));
      const doc    = await PDFDocument.load(bytes);
      const copied = await merged.copyPages(doc, doc.getPageIndices());
      copied.forEach(p => merged.addPage(p));
    }

    const pdfBytes = await merged.save();
    fs.writeFileSync(output, pdfBytes);
    return { output, sources: files, num_pages: merged.getPageCount(), error: null, exitCode: 0 };
  }

  // ── Add page to existing PDF ───────────────────────────────────────────────

  async _addPage(args) {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const absPath  = path.resolve(args.filepath);
    const fontSize = args.font_size || 12;
    const margin   = args.margin   || 50;

    const existing = fs.readFileSync(absPath);
    const pdfDoc   = await PDFDocument.load(existing);
    const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const page = pdfDoc.addPage();
    const { width, height } = page.getSize();
    let y = height - margin;

    if (args.title) {
      page.drawText(args.title, { x: margin, y, size: fontSize + 4, font: boldFont });
      y -= (fontSize + 4) * 1.8;
    }
    this._drawWrappedText(page, font, args.text || '', margin, y, width - margin * 2, fontSize);

    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(absPath, pdfBytes);
    return { filepath: absPath, num_pages: pdfDoc.getPageCount(), error: null, exitCode: 0 };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Draw word-wrapped text onto a page, respecting newlines.
   * Returns any text that didn't fit (overflow) so the caller can create a new page.
   */
  _drawWrappedText(page, font, text, x, startY, maxWidth, fontSize) {
    const lineHeight = fontSize * 1.5;
    const margin     = x; // bottom margin = same as left margin
    let y = startY;

    const paragraphs = text.split('\n');

    for (let pi = 0; pi < paragraphs.length; pi++) {
      const words = paragraphs[pi].split(/\s+/).filter(Boolean);

      if (words.length === 0) {
        // Blank line (paragraph break)
        y -= lineHeight;
        if (y < margin) {
          // Return remaining paragraphs as overflow
          return paragraphs.slice(pi + 1).join('\n');
        }
        continue;
      }

      let line = '';
      for (let wi = 0; wi < words.length; wi++) {
        const word     = words[wi];
        const testLine = line ? `${line} ${word}` : word;
        const w        = font.widthOfTextAtSize(testLine, fontSize);

        if (w > maxWidth && line) {
          page.drawText(line, { x, y, size: fontSize, font });
          y -= lineHeight;
          line = word;
          if (y < margin) {
            // Overflow: return remaining words + paragraphs
            const remaining = [words.slice(wi).join(' '), ...paragraphs.slice(pi + 1)].join('\n');
            return remaining;
          }
        } else {
          line = testLine;
        }
      }

      if (line) {
        page.drawText(line, { x, y, size: fontSize, font });
        y -= lineHeight;
        if (y < margin && pi < paragraphs.length - 1) {
          return paragraphs.slice(pi + 1).join('\n');
        }
      }
    }

    return ''; // no overflow
  }

  getContext() {
    const registryPath = path.join(__dirname, 'registry.md');
    if (fs.existsSync(registryPath)) {
      return fs.readFileSync(registryPath, 'utf8');
    }
    return '';
  }
}

module.exports = PdfTool;
