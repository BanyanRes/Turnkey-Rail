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

const FIELDS = ['project_id', 'category', 'filename', 'notes'];

// GET /api/documents  — list, filterable
router.get('/', (req, res) => {
  const db = getDb();
  const where = [];
  const params = {};
  if (req.query.project_id) {
    where.push('d.project_id = @project_id');
    params.project_id = req.query.project_id;
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
      p.name AS project_name
    FROM documents d
    LEFT JOIN projects p ON p.id = d.project_id
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
  const info = db.prepare(`
    INSERT INTO documents (project_id, category, filename, stored_path, mime_type, size_bytes, notes)
    VALUES (@project_id, @category, @filename, @stored_path, @mime_type, @size_bytes, @notes)
  `).run({
    project_id: projectId,
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
      values[f] = req.body[f];
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
