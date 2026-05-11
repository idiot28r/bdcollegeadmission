
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function checkIds() {
  const { data, error } = await supabase.from('questions').select('id').limit(10);
  if (error) {
    console.error('Error:', error);
    return;
  }
  console.log('Current IDs:', data);
}

checkIds();
