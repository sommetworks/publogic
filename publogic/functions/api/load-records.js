// Returns every saved report record, so the browser can replay the full
// upload history back into venues[] before this session's own files are
// ingested on top of it. See save-records.js for the write side and
// app.js's loadPersistedRecords/applyRecord for how the client uses this.
//
// Fails soft: if the D1 binding isn't configured yet (PC hasn't finished the
// one-time setup), this returns an empty list rather than an error, so the
// app behaves exactly as it did before persistence existed — session-only —
// until setup is complete.
export async function onRequestGet(context) {
  const { env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (!env.DB) {
    return new Response(JSON.stringify({ records: [], note: 'D1 database not configured' }), { headers: corsHeaders });
  }

  try {
    const { results } = await env.DB.prepare(
      'SELECT venue, bucket, k1, k2, data FROM report_records'
    ).all();
    return new Response(JSON.stringify({ records: results || [] }), { headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, records: [] }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
