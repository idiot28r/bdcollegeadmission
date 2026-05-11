import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing Supabase credentials in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

function cleanText(t) {
  if (!t) return t;
  // Matches "1. ", "24) ", "১. ", "১০। ", "ক) ", "A. " at the start, including within HTML tags like <p><strong>
  // This is a bit more aggressive to catch the patterns in your solution/explanation
  let cleaned = t;
  
  // 1. Remove from start of string
  cleaned = cleaned.replace(/^[\d\u09E6-\u09EFa-zA-Z\u0995-\u09B1]+[\s.\u0964\)]+\s*/, "");
  
  // 2. Remove from start of common HTML patterns used in solutions: <p><strong>1)</strong> ...
  cleaned = cleaned.replace(/(<p>)?(<strong>)?[\d\u09E6-\u09EFa-zA-Z\u0995-\u09B1]+[\s.\u0964\)]+\s*(<\/strong>)?/g, (match, p1, p2, p3) => {
      // If it looks like a tag wrapped label, remove just the label part
      return (p1 || "") + (p2 || "") + (p3 || "");
  });

  // Clean up empty strong tags if any
  cleaned = cleaned.replace(/<strong>\s*<\/strong>/g, "");
  
  return cleaned.trim();
}

async function cleanDatabase() {
  console.log('--- Cleaning Explanation and Solution Fields ---');
  
  const { data: questions, error } = await supabase.from('questions').select('id, explanation, solution');
  
  if (error) {
    console.error(error);
    return;
  }

  let updateCount = 0;
  for (const q of questions) {
    const newExp = cleanText(q.explanation);
    const newSol = cleanText(q.solution);

    if (newExp !== q.explanation || newSol !== q.solution) {
      const { error: updateError } = await supabase
        .from('questions')
        .update({ 
            explanation: newExp, 
            solution: newSol 
        })
        .eq('id', q.id);
      
      if (!updateError) updateCount++;
    }
  }

  console.log(`Successfully cleaned ${updateCount} records in Supabase.`);
  console.log('--- Cleaning Complete ---');
}

cleanDatabase();
