// Wipes all saved report history. Only reachable via the "Clear saved
// history" link on the upload panel, which confirms with the user first —
// this endpoint itself does no additional confirmation, so it should never
// be exposed as a casual action anywhere else in the UI.
export async function onRequestPost(context) {
  const { env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (!env.DB) {
    return new Response(JSON.stringify({ cleared: false, note: 'D1 database not configured' }), { headers: corsHeaders });
  }

  try {
    await env.DB.prepare('DELETE FROM report_records').run();
    return new Response(JSON.stringify({ cleared: true }), { headers: corsHeaders });
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
