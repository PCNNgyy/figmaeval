import {createHash, randomBytes} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const reject = (status, message) => { throw Object.assign(new Error(message), {status}); };

export function arenaAccounts(db, legacyReviewers, {openRegistration = false} = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS reviewer_accounts (
    reviewer_id TEXT PRIMARY KEY REFERENCES reviewers(id), secret_hash TEXT UNIQUE NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`);
  const registered = id => Boolean(db.prepare('SELECT 1 FROM reviewer_accounts WHERE reviewer_id=?').get(id));
  function reviewers() {
    const rows = legacyReviewers.map(r => ({...r, label: db.prepare('SELECT label FROM reviewers WHERE id=?').get(r.id).label}));
    if (openRegistration) for (const row of db.prepare(`SELECT r.id,r.label FROM reviewer_accounts a
      JOIN reviewers r ON r.id=a.reviewer_id WHERE a.enabled=1 ORDER BY a.created_at,r.id`).all()) {
      if (!rows.some(r => r.id === row.id)) rows.push(row);
    }
    return rows;
  }
  function enroll(body, currentReviewer = null) {
    if (!openRegistration) reject(403, '本轮尚未开放统一评审入口');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const secret = body?.profile_secret;
    if (!name || name.length > 40 || /[\x00-\x1f\x7f]/.test(name)) reject(400, '请填写1～40字的姓名或内部昵称');
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(secret)) reject(400, '浏览器身份无效，请刷新后重试');
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT * FROM reviewer_accounts WHERE secret_hash=?').get(hash(secret));
      if (prior && !prior.enabled) reject(403, '此评审身份已停用');
      let id = prior?.reviewer_id;
      if (!id && currentReviewer && legacyReviewers.some(r => r.id === currentReviewer) && !registered(currentReviewer)) id = currentReviewer;
      const at = new Date().toISOString();
      if (!id) {
        id = `participant-${randomBytes(12).toString('hex')}`;
        db.prepare('INSERT INTO reviewers VALUES (?,?,?)').run(id, name, hash(randomBytes(32)));
      }
      if (!prior) db.prepare('INSERT INTO reviewer_accounts VALUES (?,?,1,?)').run(id, hash(secret), at);
      db.prepare('UPDATE reviewers SET label=? WHERE id=?').run(name, id);
      if (!prior) db.prepare('INSERT INTO events(kind,reviewer_id,body,created_at) VALUES (?,?,?,?)')
        .run('reviewer-enrolled', id, JSON.stringify({label:name,linked_existing_identity:id===currentReviewer}), at);
      db.exec('COMMIT');
      return {id, label:name};
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return {openRegistration, reviewers, registered, enroll};
}
