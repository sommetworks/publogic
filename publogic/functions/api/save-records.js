// Upserts a batch of report records — one per (venue, bucket, k1, k2),
// keyed so re-uploading the same report overwrites its own row instead of
// creating a duplicate. The client always sends the FULL current set of
// records derived from its merged venues[] state (see app.js's
// collectAllRecords), not just what changed, so this is a plain upsert of
// everything it's given — self-healing, no delta-tracking needed on either
// side.
//
// Chunked into small batches rather than one env.DB.batch() call for the
// whole set, to stay comfortably clear of any per-batch statement limit
// regardless of how large PC's history grows.
const CHUNK_SIZE = 25;

export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    const body = await request.json();
    const records = Array.isArray(body.records) ? body.records : [];
    if (!records.length) {
      return new Response(JSON.stringify({ saved: 0 }), { headers: corsHeaders });
    }

    if (!env.DB) {
      // Not configured yet — fail soft so the app still renders this
      // session's analysis, it just won't be there next time.
      return new Response(JSON.stringify({ saved: 0, note: 'D1 database not configured' }), { headers: corsHeaders });
    }

    const now = new Date().toISOString();
    const stmt = env.DB.prepare(
      `INSERT INTO report_records (venue, bucket, k1, k2, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(venue, bucket, k1, k2) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    );

    let saved = 0;
    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE).map(r => stmt.bind(
        String(r.venue ?? ''),
        String(r.bucket ?? ''),
        String(r.k1 ?? ''),
        String(r.k2 ?? ''),
        String(r.data ?? ''),
        now,
      ));
      await env.DB.batch(chunk);
      saved += chunk.length;
    }

    return new Response(JSON.stringify({ saved }), { headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
