// Admin proxy. Verifies admin credentials against the `admins` table (via the
// admin_login RPC) and performs the requested DB operation with the
// service_role key. The service_role key never reaches the browser.
//
// Supabase injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY automatically
// when the function is deployed; no manual secret-setting required.
//
// Deploy:  supabase functions deploy admin-op

import { createClient } from 'npm:@supabase/supabase-js@^2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface BaseReq {
  username: string;
  password: string;
  op: string;
  payload: unknown;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let body: BaseReq;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Bad JSON' });
  }

  const { username, password, op, payload } = body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return json(400, { error: 'Missing credentials' });
  }
  if (typeof op !== 'string') return json(400, { error: 'Missing op' });

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify credentials via the existing admin_login RPC.
  const { data: loginRows, error: loginErr } = await sb.rpc('admin_login', {
    p_username: username,
    p_password: password,
  });
  if (loginErr) return json(500, { error: 'Auth check failed: ' + loginErr.message });
  const session = Array.isArray(loginRows) ? loginRows[0] : loginRows;
  if (!session || !session.id) return json(401, { error: 'Invalid credentials' });

  try {
    switch (op) {
      case 'insert_questions': {
        if (!Array.isArray(payload)) return json(400, { error: 'payload must be an array' });
        const { data, error } = await sb.from('questions').insert(payload).select();
        if (error) return json(400, { error: error.message });
        return json(200, { data });
      }
      case 'update_question': {
        const p = payload as { id?: string; fields?: Record<string, unknown> };
        if (!p?.id || !p.fields || typeof p.fields !== 'object') {
          return json(400, { error: 'invalid payload' });
        }
        // Strip id from the fields so it can't be rewritten via the update.
        const { id: _ignore, ...safeFields } = p.fields;
        void _ignore;
        const { data, error } = await sb.from('questions').update(safeFields).eq('id', p.id).select();
        if (error) return json(400, { error: error.message });
        return json(200, { data });
      }
      case 'toggle_question_hidden': {
        const p = payload as { id?: string; hidden?: boolean };
        if (!p?.id || typeof p.hidden !== 'boolean') return json(400, { error: 'invalid payload' });
        const { data, error } = await sb.from('questions').update({ hidden: p.hidden }).eq('id', p.id).select();
        if (error) return json(400, { error: error.message });
        return json(200, { data });
      }
      case 'update_settings': {
        const p = (payload ?? {}) as Record<string, unknown>;
        const allowed = ['font_bn', 'font_en', 'banner_enabled', 'banner_message'];
        const update: Record<string, unknown> = { id: 1 };
        for (const k of allowed) {
          if (k in p) update[k] = p[k];
        }
        if (Object.keys(update).length === 1) {
          return json(400, { error: 'no valid fields to update' });
        }
        const { error } = await sb.from('settings').upsert(update);
        if (error) return json(400, { error: error.message });
        return json(200, { ok: true });
      }
      default:
        return json(400, { error: 'Unknown op: ' + op });
    }
  } catch (e) {
    return json(500, { error: 'Unexpected error: ' + (e as Error).message });
  }
});
