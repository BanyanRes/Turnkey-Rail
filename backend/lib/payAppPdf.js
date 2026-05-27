// AIA-style G702 + G703 PDF generator for a pay application.
//
// Renders to a stream so the route can pipe straight to the HTTP response.
// Layout follows the standard AIA Document G702 (Application & Certificate)
// + G703 (Continuation Sheet) but reworded slightly because we don't license
// the AIA template — labels and structure match conceptually.

const PDFDocument = require('pdfkit');

function fmtMoney(n) {
  const num = Number(n || 0);
  return num.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function fmtPct(num, den) {
  if (!den || den === 0) return '0.0%';
  return ((num / den) * 100).toFixed(1) + '%';
}

// Public API: stream a PDF for one pay app into `res`.
function renderPayAppPdf(res, ctx) {
  const {
    payApp,         // full pay-app row (with totals)
    lines,          // array of pay_app_lines
    project,        // { code, name, address? }
    vendor,         // { name, trade } | null  (null => owner billing)
    issuerName,     // optional: GC's display name
  } = ctx;

  // Document — Letter, landscape (G703 has many columns)
  const doc = new PDFDocument({
    size: 'LETTER',
    layout: 'landscape',
    margins: { top: 36, bottom: 36, left: 36, right: 36 },
    info: {
      Title: `Pay App #${payApp.app_number} — ${project.code}`,
      Author: issuerName || 'Turnkey Rail',
      Subject: 'Application for Payment (AIA G702/G703 style)',
    },
  });
  doc.pipe(res);

  drawG702(doc, { payApp, project, vendor, issuerName });
  doc.addPage();
  drawG703(doc, { payApp, lines, project });

  doc.end();
}

// ===== G702 — Application and Certificate =====
function drawG702(doc, { payApp, project, vendor, issuerName }) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;
  let y = doc.page.margins.top;

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text('APPLICATION FOR PAYMENT', left, y);
  doc.font('Helvetica').fontSize(9).fillColor('#555').text('AIA Document G702-style', left, y + 22);
  doc.fontSize(10).fillColor('#000');
  y += 50;

  const colW = pageWidth / 3 - 8;
  const c1 = left;
  const c2 = left + colW + 12;
  const c3 = left + (colW + 12) * 2;

  const recipientLabel = vendor ? 'TO CONTRACTOR' : 'TO OWNER';
  const recipientName  = vendor ? `${vendor.name}${vendor.trade ? ' (' + vendor.trade + ')' : ''}` : 'Project Owner';
  const fromName = issuerName || 'General Contractor';

  drawLabeledBox(doc, c1, y, colW, 70, recipientLabel, recipientName);
  drawLabeledBox(doc, c2, y, colW, 70, 'FROM',
    fromName + (vendor ? '\n(General Contractor)' : '\n(General Contractor to Owner)'));
  drawLabeledBox(doc, c3, y, colW, 70, 'PROJECT',
    `${project.code} — ${project.name}${project.address ? '\n' + project.address : ''}`);
  y += 80;

  const metaH = 36;
  const metaCols = 4;
  const metaW = pageWidth / metaCols;
  const periodText = (payApp.period_start && payApp.period_end)
    ? `${payApp.period_start} to ${payApp.period_end}`
    : (payApp.period_end || '—');
  drawLabeledBox(doc, c1 + 0 * metaW, y, metaW - 6, metaH, 'APPLICATION NO.', `#${payApp.app_number}`);
  drawLabeledBox(doc, c1 + 1 * metaW, y, metaW - 6, metaH, 'PERIOD', periodText);
  drawLabeledBox(doc, c1 + 2 * metaW, y, metaW - 6, metaH, 'RETAINAGE', `${payApp.retainage_pct}%`);
  drawLabeledBox(doc, c1 + 3 * metaW, y, metaW - 6, metaH, 'STATUS', (payApp.status || 'draft').toUpperCase());
  y += metaH + 14;

  // Financial summary box (AIA G702 lines 1-9 style)
  const lineH = 22;
  const labelW = pageWidth * 0.62;
  const valueW = pageWidth - labelW;

  const cs = Number(payApp.contract_sum || 0);
  const co = Number(payApp.change_orders || 0);
  const contractToDate = cs + co;
  const totalCompleted = Number(payApp.total_completed || 0);
  const retainagePct = Number(payApp.retainage_pct || 0);
  const retainageAmt = Number(payApp.retainage_amount || 0);
  const earnedLessRet = Number(payApp.earned_less_retainage || 0);
  const priorTotal = Number(payApp.prior_total || 0);
  const priorNet = priorTotal * (1 - retainagePct / 100);
  const currentDue = Number(payApp.current_due || 0);
  const balanceToFinish = Math.max(0, contractToDate - totalCompleted);

  const rows = [
    ['1.  ORIGINAL CONTRACT SUM',                         fmtMoney(cs),             false],
    ['2.  NET CHANGE BY CHANGE ORDERS',                   fmtMoney(co),             false],
    ['3.  CONTRACT SUM TO DATE  (Line 1 ± 2)',            fmtMoney(contractToDate), true],
    ['4.  TOTAL COMPLETED & STORED TO DATE',              fmtMoney(totalCompleted), false],
    [`5.  RETAINAGE  (${retainagePct}% of Line 4)`,       fmtMoney(retainageAmt),   false],
    ['6.  TOTAL EARNED LESS RETAINAGE  (Line 4 − 5)',     fmtMoney(earnedLessRet),  true],
    ['7.  LESS PREVIOUS CERTIFICATES (net of retainage)', '(' + fmtMoney(priorNet) + ')', false],
    ['8.  CURRENT PAYMENT DUE  (Line 6 − 7)',             fmtMoney(currentDue),     true],
    ['9.  BALANCE TO FINISH, INCLUDING RETAINAGE',        fmtMoney(balanceToFinish), false],
  ];

  doc.lineWidth(0.75).strokeColor('#333')
    .rect(left, y, pageWidth, rows.length * lineH).stroke();

  rows.forEach((r, i) => {
    const ry = y + i * lineH;
    if (i % 2 === 1) {
      doc.fillColor('#f7f7f7').rect(left + 0.5, ry + 0.5, pageWidth - 1, lineH - 1).fill();
    }
    if (i > 0) {
      doc.strokeColor('#ddd').lineWidth(0.4)
        .moveTo(left, ry).lineTo(left + pageWidth, ry).stroke();
    }
    doc.font(r[2] ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(11).fillColor('#000')
      .text(r[0], left + 10, ry + 6, { width: labelW - 10 });
    doc.font(r[2] ? 'Helvetica-Bold' : 'Helvetica')
      .text(r[1], left + labelW, ry + 6, { width: valueW - 10, align: 'right' });
  });

  y += rows.length * lineH + 24;

  doc.font('Helvetica').fontSize(9).fillColor('#333').text(
    'The undersigned applicant certifies that to the best of their knowledge, information and belief, ' +
    'the Work covered by this Application has been completed in accordance with the Contract Documents, ' +
    'that previous certificates for payment were issued and payments received from the Owner, and that ' +
    'current payment shown herein is now due.',
    left, y, { width: pageWidth, align: 'justify' }
  );
  y += 50;

  const sigW = (pageWidth - 30) / 2;
  drawSignatureLine(doc, left, y, sigW, 'Applicant (General Contractor)');
  drawSignatureLine(doc, left + sigW + 30, y, sigW, vendor ? 'Subcontractor' : 'Owner / Architect');
}

// ===== G703 — Continuation Sheet =====
function drawG703(doc, { payApp, lines, project }) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;
  let y = doc.page.margins.top;

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111')
    .text('CONTINUATION SHEET — Schedule of Values  (G703)', left, y);
  doc.font('Helvetica').fontSize(9).fillColor('#555')
    .text(`${project.code} — ${project.name}  ·  Pay App #${payApp.app_number}`, left, y + 18);
  y += 38;

  const cols = [
    { key: 'item',          label: '#',                   w: 22, align: 'left' },
    { key: 'description',   label: 'DESCRIPTION OF WORK', w: 0,  align: 'left'  },
    { key: 'scheduled',     label: 'SCHEDULED VALUE (C)', w: 90, align: 'right' },
    { key: 'prior',         label: 'PRIOR (D)',           w: 75, align: 'right' },
    { key: 'thisPeriod',    label: 'THIS PERIOD (E)',     w: 85, align: 'right' },
    { key: 'stored',        label: 'STORED (F)',          w: 70, align: 'right' },
    { key: 'totalComplete', label: 'TOTAL (G)',           w: 85, align: 'right' },
    { key: 'pctComplete',   label: '%',                   w: 40, align: 'right' },
    { key: 'toFinish',      label: 'TO FINISH',           w: 80, align: 'right' },
  ];
  const fixedW = cols.reduce((s, c) => s + c.w, 0);
  cols[1].w = pageWidth - fixedW;

  const headH = 24;
  doc.lineWidth(0.6).strokeColor('#333');
  doc.fillColor('#f0f0f0').rect(left, y, pageWidth, headH).fill();
  doc.strokeColor('#333').rect(left, y, pageWidth, headH).stroke();
  let cx = left;
  cols.forEach((c) => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000');
    doc.text(c.label, cx + 4, y + 8, { width: c.w - 8, align: c.align });
    cx += c.w;
    if (c !== cols[cols.length - 1]) {
      doc.strokeColor('#ccc').lineWidth(0.3)
        .moveTo(cx, y).lineTo(cx, y + headH).stroke();
    }
  });
  y += headH;

  const rowH = 20;
  doc.font('Helvetica').fontSize(9).fillColor('#000');
  let totals = { scheduled: 0, prior: 0, thisPeriod: 0, stored: 0, totalComplete: 0 };

  lines.forEach((l, idx) => {
    if (y + rowH > doc.page.height - doc.page.margins.bottom - 60) {
      drawPageFooter(doc);
      doc.addPage();
      y = doc.page.margins.top;
    }

    const scheduled = Number(l.scheduled_value || 0);
    const prior = Number(l.completed_previous || 0);
    const thisPeriod = Number(l.completed_this_period || 0);
    const stored = Number(l.stored_materials || 0);
    const totalComplete = prior + thisPeriod + stored;
    const toFinish = scheduled - totalComplete;

    totals.scheduled += scheduled;
    totals.prior += prior;
    totals.thisPeriod += thisPeriod;
    totals.stored += stored;
    totals.totalComplete += totalComplete;

    if (idx % 2 === 1) {
      doc.fillColor('#fafafa').rect(left + 0.3, y + 0.3, pageWidth - 0.6, rowH - 0.6).fill();
    }
    doc.strokeColor('#eee').lineWidth(0.3)
      .moveTo(left, y + rowH).lineTo(left + pageWidth, y + rowH).stroke();

    const cells = {
      item: String(idx + 1),
      description: l.description || '',
      scheduled: fmtMoney(scheduled),
      prior: fmtMoney(prior),
      thisPeriod: fmtMoney(thisPeriod),
      stored: fmtMoney(stored),
      totalComplete: fmtMoney(totalComplete),
      pctComplete: fmtPct(totalComplete, scheduled),
      toFinish: fmtMoney(toFinish),
    };

    cx = left;
    cols.forEach((c) => {
      doc.fillColor('#000').font('Helvetica').fontSize(9);
      doc.text(cells[c.key], cx + 4, y + 6, { width: c.w - 8, align: c.align, ellipsis: true, height: rowH - 4 });
      cx += c.w;
    });

    y += rowH;
  });

  if (y + rowH > doc.page.height - doc.page.margins.bottom - 60) {
    drawPageFooter(doc);
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.fillColor('#eef2ff').rect(left, y, pageWidth, rowH + 4).fill();
  doc.strokeColor('#333').lineWidth(0.6).rect(left, y, pageWidth, rowH + 4).stroke();

  const totalCells = {
    item: '',
    description: 'TOTAL',
    scheduled: fmtMoney(totals.scheduled),
    prior: fmtMoney(totals.prior),
    thisPeriod: fmtMoney(totals.thisPeriod),
    stored: fmtMoney(totals.stored),
    totalComplete: fmtMoney(totals.totalComplete),
    pctComplete: fmtPct(totals.totalComplete, totals.scheduled),
    toFinish: fmtMoney(totals.scheduled - totals.totalComplete),
  };
  cx = left;
  cols.forEach((c) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
    doc.text(totalCells[c.key], cx + 4, y + 8, { width: c.w - 8, align: c.align });
    cx += c.w;
  });

  drawPageFooter(doc);
}

// helpers
function drawLabeledBox(doc, x, y, w, h, label, value) {
  doc.lineWidth(0.6).strokeColor('#333').rect(x, y, w, h).stroke();
  doc.fontSize(8).fillColor('#666').font('Helvetica-Bold').text(label, x + 6, y + 4);
  doc.fontSize(11).fillColor('#000').font('Helvetica').text(value, x + 6, y + 18, {
    width: w - 12, height: h - 20, ellipsis: true,
  });
}

function drawSignatureLine(doc, x, y, w, label) {
  doc.lineWidth(0.5).strokeColor('#333')
    .moveTo(x, y + 16).lineTo(x + w, y + 16).stroke();
  doc.fontSize(9).fillColor('#666').font('Helvetica').text(label, x, y + 20);
  doc.fontSize(9).fillColor('#666').text('Date: _______________', x + w - 110, y + 20);
}

function drawPageFooter(doc) {
  const w = doc.page.width;
  const h = doc.page.height;
  doc.fontSize(8).fillColor('#888').font('Helvetica').text(
    'Generated by Turnkey Rail',
    36, h - 28, { width: w - 72, align: 'center' }
  );
}

module.exports = { renderPayAppPdf };
