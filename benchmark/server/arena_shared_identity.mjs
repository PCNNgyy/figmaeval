export function synchronizeArenaIdentities(source,target){
 if(!source||source===target)return;
 const rows=source.db.prepare(`SELECT r.id,r.label,r.token_hash,a.secret_hash,a.enabled,a.created_at
  FROM reviewers r JOIN reviewer_accounts a ON a.reviewer_id=r.id`).all();
 const changed=rows.filter(r=>{
  const current=target.db.prepare(`SELECT r.label,a.secret_hash,a.enabled,a.created_at FROM reviewers r
   JOIN reviewer_accounts a ON a.reviewer_id=r.id WHERE r.id=?`).get(r.id);
  return !current||current.label!==r.label||current.secret_hash!==r.secret_hash||current.enabled!==r.enabled||current.created_at!==r.created_at;
 });
 if(!changed.length)return;
 target.db.exec('BEGIN IMMEDIATE');
 try{
  for(const r of changed){
   const collision=target.db.prepare('SELECT reviewer_id FROM reviewer_accounts WHERE secret_hash=?').get(r.secret_hash);
   if(collision&&collision.reviewer_id!==r.id)throw Error('Reviewer credential belongs to another identity');
   target.db.prepare(`INSERT INTO reviewers(id,label,token_hash) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label`).run(r.id,r.label,r.token_hash);
   target.db.prepare(`INSERT INTO reviewer_accounts(reviewer_id,secret_hash,enabled,created_at) VALUES (?,?,?,?)
    ON CONFLICT(reviewer_id) DO UPDATE SET secret_hash=excluded.secret_hash,enabled=excluded.enabled`).run(r.id,r.secret_hash,r.enabled,r.created_at);
  }
  target.db.exec('COMMIT');
 }catch(error){target.db.exec('ROLLBACK');throw error;}
 source.refreshReviewers();target.refreshReviewers();
}
