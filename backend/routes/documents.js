// Documents — file uploads tied to projects
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');

const router = express.Router();

const FILES_DIR = path.join(
  process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  'files'
);
if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

// Multer config: store on disk with a unique server-side name; keep original in DB
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FILES_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    // strip any path bits, keep extension
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${ts}-${rand}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB cap
});

// pay_app_id is included so a doc can be (re)attached or detached (null) at any time.
const FIELDS = ['project_id', 'pay_app_id', 'category', 'filename', 'notes'];

// Find the active Owner draft pay app on a project to auto-attach new uploads to.
// Monthly close-out docs (photos, receipts, invoices) belong to the owner billing
// package by default. Returns null if no draft Owner pay app exists yet.
function findActiveOwnerPayApp(db, projectId) {
  if (!projectId) return null;
  return db.prepare(`
    SELECT id FROM pay_applications
    WHERE project_id = ?
      AND subcontractor_id IS NULL
      AND status = 'draft'
    ORDER BY datetime(updated_at) DESC, id DESC
    LIMIT 1
  `).get(projectId);
}

// GET /api/documents  — list, filterable
router.get('/', (req, res) => {
  const db = getDb();
  const where = [];
  const params = {};
  if (req.query.project_id) {
    where.push('d.project_id = @project_id');
    params.project_id = req.query.project_id;
  }
  if (req.query.pay_app_id != null && req.query.pay_app_id !== '') {
    // pay_app_id=null is the convention for "unattached docs for this project".
    if (req.query.pay_app_id === 'null') {
      where.push('d.pay_app_id IS NULL');
    } else {
      where.push('d.pay_app_id = @pay_app_id');
      params.pay_app_id = req.query.pay_app_id;
    }
  }
  if (req.query.category) {
    where.push('d.category = @category');
    params.category = req.query.category;
  }
  if (req.query.q) {
    where.push('(d.filename LIKE @q OR d.notes LIKE @q)');
    params.q = `%${req.query.q}%`;
  }
  const sql = `
    SELECT
      d.*,
      p.code AS project_code,
      p.name AS project_name,
      pa.app_number AS pay_app_number,
      pa.subcontractor_id AS pay_app_subcontractor_id
    FROM documents d
    LEFT JOIN projects p ON p.id = d.project_id
    LEFT JOIN pay_applications pa ON pa.id = d.pay_app_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY d.created_at DESC
  `;
  res.json(db.prepare(sql).all(params));
});

// POST /api/documents  — upload a file
// multipart fields: file, project_id, category, notes
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const db = getDb();
  const projectId = req.body.project_id ? Number(req.body.project_id) : null;
  if (projectId) {
    const exists = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!exists) {
      // clean up the uploaded file
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'Invalid project_id' });
    }
  }

  // Resolve pay_app_id. Three paths:
  //   - Explicit id  → use it after validating project membership.
  //   - "none"/"null" → opt out of auto-attach, leave NULL.
  //   - Nothing given + projectId set → auto-attach to active Owner draft.
  const rawPayApp = req.body.pay_app_id;
  let payAppId = null;
  if (rawPayApp != null && rawPayApp !== '') {
    if (rawPayApp === 'none' || rawPayApp === 'null') {
      payAppId = null;
    } else {
      const id = Number(rawPayApp);
      const pa = db.prepare('SELECT id, project_id FROM pay_applications WHERE id = ?').get(id);
      if (!pa) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: 'Invalid pay_app_id' });
      }
      if (projectId && pa.project_id !== projectId) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ error: 'pay_app_id does not belong to the given project' });
      }
      payAppId = pa.id;
    }
  } else if (projectId) {
    const active = findActiveOwnerPayApp(db, projectId);
    payAppId = active ? active.id : null;
  }

  const info = db.prepare(`
    INSERT INTO documents (project_id, pay_app_id, category, filename, stored_path, mime_type, size_bytes, notes)
    VALUES (@project_id, @pay_app_id, @category, @filename, @stored_path, @mime_type, @size_bytes, @notes)
  `).run({
    project_id: projectId,
    pay_app_id: payAppId,
    category: req.body.category || null,
    filename: req.file.originalname,
    stored_path: path.basename(req.file.path), // store relative name only
    mime_type: req.file.mimetype,
    size_bytes: req.file.size,
    notes: req.body.notes || null,
  });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(doc);
});

// PATCH /api/documents/:id  — update metadata only (not the file itself)
router.patch('/:id', (req, res) => {
  const db = getDb();
  const updates = [];
  const values = {};
  for (const f of FIELDS) {
    if (f in req.body) {
      updates.push(`${f} = @${f}`);
      let v = req.body[f];
      // Allow the client to detach a doc by sending pay_app_id="none"/"null"/"".
      if (f === 'pay_app_id' && (v === 'none' || v === 'null' || v === '')) v = null;
      values[f] = v;
    }
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }
  updates.push(`updated_at = datetime('now')`);
  values.id = req.params.id;
  const result = db.prepare(
    `UPDATE documents SET ${updates.join(', ')} WHERE id = @id`
  ).run(values);
  if (result.changes === 0) return res.status(404).json({ error: 'Document not found' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  res.json(doc);
});

// GET /api/documents/:id/download  — stream the file
router.get('/:id/download', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const filePath = path.join(FILES_DIR, doc.stored_path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File missing on disk' });
  }
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  // inline disposition lets browser preview PDFs / images; client can override w/ query
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(doc.filename)}"`);
  fs.createReadStream(filePath).pipe(res);
});

// DELETE /api/documents/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const filePath = path.join(FILES_DIR, doc.stored_path);
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  // Best-effort file delete (don't fail the request if the file is already gone)
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { console.error('unlink', e); }
  res.json({ ok: true, deleted: Number(req.params.id) });
});

module.exports = router;
