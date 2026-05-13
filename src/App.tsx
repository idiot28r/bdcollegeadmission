import { useState, useEffect, useMemo } from 'react'
import katex from 'katex'
import { supabase } from './supabaseClient'
import './App.css'
import './Admin.css'

interface Question {
  id: string;
  serial?: string | number;
  type: 'mcq' | 'sq';
  institution: string;
  year: string | number;
  subject: string;
  topic?: string;
  question?: string;
  options?: string[];
  answer_index?: number;
  explanation?: string;
  stimulus?: string;
  parts?: { label: string; question: string; mark: number }[];
  solution?: string;
  hidden?: boolean;
}

const SUBJECT_COLORS: Record<string, string> = {
  Physics: 'var(--color-physics)',
  Chemistry: 'var(--color-chemistry)',
  Math: 'var(--color-math)',
  Biology: 'var(--color-biology)',
  English: 'var(--color-english)',
  GK: 'var(--color-gk)',
};

const VALID_INSTITUTIONS = ['NDC', 'HCC', 'SJHSS'];

function validateQuestion(q: Question): { isValid: boolean; error?: string } {
  if (!q.institution || !q.year || !q.subject) return { isValid: false, error: "Missing metadata" };
  if (!VALID_INSTITUTIONS.includes(q.institution)) return { isValid: false, error: "Invalid institution (must be NDC, HCC, or SJHSS)" };
  if (q.serial === undefined || q.serial === "") return { isValid: false, error: "Missing serial number" };
  
  if (q.type === 'mcq') {
    if (!q.question) return { isValid: false, error: "Missing question" };
    if (!q.options || q.options.length !== 4) return { isValid: false, error: "MCQ needs 4 options" };
    if (q.answer_index === undefined) return { isValid: false, error: "Missing answer index" };
  } else {
    if (!q.stimulus && (!q.parts || q.parts.length === 0)) return { isValid: false, error: "SQ needs content" };
    if (!q.solution) return { isValid: false, error: "Missing solution" };
  }
  return { isValid: true };
}

interface Settings {
  autoExp: boolean;
  showOpt: boolean;
  showAns: boolean;
  showExp: boolean;
}

const DEFAULT_SETTINGS: Settings = { autoExp: false, showOpt: true, showAns: false, showExp: false };

function sortQuestions(qs: Question[]): Question[] {
  return [...qs].sort((a, b) => {
    if (a.institution !== b.institution) return String(a.institution || "").localeCompare(String(b.institution || ""));
    const yearA = Number(String(a.year || "").split('-')[0]);
    const yearB = Number(String(b.year || "").split('-')[0]);
    if (yearA !== yearB) return yearB - yearA;
    if (a.subject !== b.subject) return String(a.subject || "").localeCompare(String(b.subject || ""));
    if (a.type !== b.type) return String(a.type || "").localeCompare(String(b.type || ""));
    return Number(a.serial || 0) - Number(b.serial || 0);
  });
}

function cleanText(t: string) {
  if (!t) return "";
  // Remove leading numbers like "1. ", "24) ", "১. ", "১০। "
  return t.replace(/^[\d\u09E6-\u09EF]+[\s.\u0964\)]+\s*/, "").trim();
}

function renderMath(text: string) {
  if (!text) return "";
  const cleaned = cleanText(text);
  let res = cleaned.replace(/\$\$(.*?)\$\$/gs, (_, m) => katex.renderToString(m, { displayMode: true, throwOnError: false }));
  res = res.replace(/\\\[(.*?)\\\]/gs, (_, m) => katex.renderToString(m, { displayMode: true, throwOnError: false }));
  res = res.replace(/\$(.*?)\$/g, (_, m) => katex.renderToString(m, { displayMode: false, throwOnError: false }));
  res = res.replace(/\\\((.*?)\\\)/g, (_, m) => katex.renderToString(m, { displayMode: false, throwOnError: false }));
  return res;
}

function EditableText({ text, onSave, className = "", isEditable = false, style = {} }: { text: string; onSave: (v: string) => void; className?: string; isEditable?: boolean; style?: React.CSSProperties }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(text);

  if (isEditable && editing) return <textarea className="edit-input" value={val} onChange={e => setVal(e.target.value)} onBlur={() => { setEditing(false); onSave(val); }} autoFocus />;
  return <div className={`${className} ${isEditable ? 'editable-field' : ''}`} style={style} onClick={() => { if (isEditable) { setEditing(true); setVal(text); } }} dangerouslySetInnerHTML={{ __html: renderMath(text) }} />;
}

function MultiSelectModal({ title, options, selected, onToggle, onClose, onSelectAll, onClear }: { title: string; options: string[]; selected: string[]; onToggle: (v: string) => void; onClose: () => void; onSelectAll: () => void; onClear: () => void }) {
  return (
    <div className="modal-overlay" style={{ display: 'flex', zIndex: 1200 }} onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>Filter by {title}</h3>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={onSelectAll}>All</button>
            <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={onClear}>Clear</button>
            <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', background: 'var(--primary)', color: 'white', border: 'none' }} onClick={onClose}>Done</button>
          </div>
        </div>
        <div className="option-grid">
          {options.length > 0 ? options.map((opt: string) => (
            <div key={opt} className={`checkbox-item ${selected.includes(opt) ? 'selected' : ''}`} onClick={() => onToggle(opt)}>{opt}</div>
          )) : <p style={{ gridColumn: '1/-1', textAlign: 'center', padding: '1rem', color: '#666' }}>No options available with current filters</p>}
        </div>
      </div>
    </div>
  );
}

function Sidebar({ isOpen, onClose, settings, onSettingChange }: { isOpen: boolean; onClose: () => void; settings: Settings; onSettingChange: (key: keyof Settings, val: boolean) => void }) {
  return (
    <>
      <div className={`modal-overlay ${isOpen ? 'open' : ''}`} style={{ display: isOpen ? 'block' : 'none', opacity: 0.5, zIndex: 1050 }} onClick={onClose} />
      <div id="sidebar" className={isOpen ? 'open' : ''}>
        <div className="sidebar-header">
          <h3 style={{ fontWeight: 700 }}>View Settings</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div style={{ marginBottom: '2rem', paddingBottom: '1rem', borderBottom: '1px solid #e5e7eb' }}>
          <div className="toggle-row">
            <div><p style={{ fontSize: '0.9rem', fontWeight: 600 }}>Auto-show Explanation</p><p style={{ fontSize: '0.75rem', color: '#666' }}>After choice</p></div>
            <label className="switch"><input type="checkbox" checked={settings.autoExp} onChange={e => onSettingChange('autoExp', e.target.checked)} /><span className="slider"></span></label>
          </div>
        </div>
        <h4 style={{ marginBottom: '1rem', color: '#6b7280', fontSize: '0.75rem', textTransform: 'uppercase' }}>Global Toggles</h4>
        <div className="toggle-row"><span>Options</span><label className="switch"><input type="checkbox" checked={settings.showOpt} onChange={e => onSettingChange('showOpt', e.target.checked)} /><span className="slider"></span></label></div>
        <div className="toggle-row"><span>Correct Answer</span><label className="switch"><input type="checkbox" checked={settings.showAns} onChange={e => onSettingChange('showAns', e.target.checked)} /><span className="slider"></span></label></div>
        <div className="toggle-row"><span>Explanation</span><label className="switch"><input type="checkbox" checked={settings.showExp} onChange={e => onSettingChange('showExp', e.target.checked)} /><span className="slider"></span></label></div>
      </div>
    </>
  );
}

function App() {
  const [isAdmin, setIsAdmin] = useState(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('admin') === 'true';
    }
    return false;
  });
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);

  // Metadata States
  const [collegeOptions, setCollegeOptions] = useState<string[]>([]);
  const [subjectOptions, setSubjectOptions] = useState<string[]>([]);
  const [typeOptions, setTypeOptions] = useState<string[]>(['MCQ', 'SQ']);
  const [yearOptions, setYearOptions] = useState<string[]>([]);

  const [selInst, setSelInst] = useState<string[]>([]);
  const [selSub, setSelSub] = useState<string[]>([]);
  const [selType, setSelType] = useState<string[]>([]);
  const [selYear, setSelYear] = useState<string[]>([]);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    // 1. Fetch Global Settings (Fonts)
    const fetchSettings = async () => {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (data && !error) {
        if (data.font_bn) document.documentElement.style.setProperty('--font-bn', data.font_bn);
        if (data.font_en) document.documentElement.style.setProperty('--font-en', data.font_en);
      }
    };

    // 2. Fetch Metadata and Total Count
    const fetchInitialData = async () => {
      // Fetch metadata for filters
      const { data: qData, error } = await supabase.from('questions').select('institution, subject, year');
      if (qData && !error) {
        setCollegeOptions(Array.from(new Set(qData.map(q => String(q.institution || "").trim()))).filter(Boolean).sort());
        setSubjectOptions(Array.from(new Set(qData.map(q => String(q.subject || "").trim()))).filter(Boolean).sort());
        setYearOptions(Array.from(new Set(qData.map(q => String(q.year || "").trim()))).filter(Boolean).sort().reverse());
      }

      // Fetch initial total count
      const { count, error: countError } = await supabase.from('questions').select('*', { count: 'exact', head: true });
      if (!countError) setTotalCount(count || 0);
    };
    
    fetchSettings();
    fetchInitialData();

    // Subscribe to settings changes for real-time global updates
    const settingsSubscription = supabase
      .channel('public:settings')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'settings' }, payload => {
        if (payload.new.font_bn) document.documentElement.style.setProperty('--font-bn', payload.new.font_bn);
        if (payload.new.font_en) document.documentElement.style.setProperty('--font-en', payload.new.font_en);
      })
      .subscribe();

    // Subscribe to questions changes for real-time total count updates
    const questionsSubscription = supabase
      .channel('public:questions_count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'questions' }, async () => {
        const { count, error: countError } = await supabase.from('questions').select('*', { count: 'exact', head: true });
        if (!countError) setTotalCount(count || 0);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(settingsSubscription);
      supabase.removeChannel(questionsSubscription);
    };
  }, []);

  const loadQuestions = async (isNewSearch = false) => {
    const currentPage = isNewSearch ? 0 : page;
    const pageSize = 20;
    const start = currentPage * pageSize;
    const end = start + pageSize - 1;

    if (isNewSearch) {
      setLoading(true);
      setQuestions([]);
    } else {
      setIsFetchingMore(true);
    }

    let query = supabase.from('questions').select('*', { count: 'exact' });

    // Apply Filters (AND between categories, IN within category)
    if (selInst.length > 0) query = query.in('institution', selInst);
    if (selSub.length > 0) query = query.in('subject', selSub);
    if (selYear.length > 0) query = query.in('year', selYear);
    if (selType.length > 0) {
      const types = selType.map(t => t.toLowerCase());
      query = query.in('type', types);
    }

    // Student View: Hide "hidden" questions
    if (!isAdmin) {
      query = query.eq('hidden', false);
    }

    // Apply Sorting (Mirroring local sortQuestions logic)
    query = query
      .order('institution', { ascending: true })
      .order('year', { ascending: false })
      .order('subject', { ascending: true })
      .order('type', { ascending: true })
      .order('serial', { ascending: true })
      .range(start, end);

    const { data, error, count } = await query;

    if (data && !error) {
      setQuestions(prev => isNewSearch ? data : [...prev, ...data]);
      setHasMore(count ? (start + data.length < count) : data.length === pageSize);
      if (isNewSearch) setFilteredCount(count || 0);
      
      if (!isNewSearch) setPage(currentPage + 1);
      else setPage(1);
    }
    
    setLoading(false);
    setIsFetchingMore(false);
  };

  // Infinite Scroll Observer
  useEffect(() => {
    if (loading || !hasMore || isFetchingMore) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        loadQuestions();
      }
    }, { threshold: 0.1, rootMargin: '400px' }); // rootMargin helps trigger before hitting bottom

    const sentinel = document.getElementById('scroll-sentinel');
    if (sentinel) observer.observe(sentinel);

    return () => observer.disconnect();
  }, [loading, hasMore, isFetchingMore, page]);

  // Re-fetch when filters change
  useEffect(() => {
    loadQuestions(true);
  }, [selInst, selSub, selType, selYear, isAdmin]);

  const updateQuestions = (newQuestions: Question[]) => {
    setQuestions(newQuestions);
  };

  const handleSettingChange = (key: keyof Settings, val: boolean) => {
    setSettings(prev => {
      const n = { ...prev, [key]: val };
      if (key === 'showExp' && val) n.showAns = true;
      if (key === 'showAns' && !val) n.showExp = false;
      return n;
    });
  };

  const clearAllFilters = () => {
    setSelInst([]);
    setSelSub([]);
    setSelType([]);
    setSelYear([]);
  };

  return (
    <div className={isAdmin ? "" : "app-container"}>
      {isAdmin ? (
        <AdminDashboard 
          questions={questions} 
          onUpdate={updateQuestions} 
          onExit={() => setIsAdmin(false)}
          collegeOptions={collegeOptions}
          subjectOptions={subjectOptions}
          typeOptions={typeOptions}
          yearOptions={yearOptions}
          selInst={selInst} setSelInst={setSelInst}
          selSub={selSub} setSelSub={setSelSub}
          selType={selType} setSelType={setSelType}
          selYear={selYear} setSelYear={setSelYear}
          onClear={clearAllFilters}
          loadMore={() => loadQuestions()}
          hasMore={hasMore}
          isLoadingMore={isFetchingMore}
          totalCount={totalCount}
          filteredCount={filteredCount}
        />
      ) : (
        <>
          <div className="sticky-top">
            <header onClick={e => e.detail === 5 && setIsAdmin(true)}>
              <h2>Admission Prep</h2>
              <button className="menu-btn" onClick={() => setIsSidebarOpen(true)} style={{ cursor: 'pointer' }}>⚙️</button>
            </header>
            <FilterBar 
              collegeOptions={collegeOptions}
              subjectOptions={subjectOptions}
              typeOptions={typeOptions}
              yearOptions={yearOptions}
              selInst={selInst} setSelInst={setSelInst}
              selSub={selSub} setSelSub={setSelSub}
              selType={selType} setSelType={setSelType}
              selYear={selYear} setSelYear={setSelYear}
              onClear={clearAllFilters}
            />
          </div>
          <main className="content-feed">
            {loading ? (
              <p style={{ textAlign: 'center', padding: '2rem' }}>Loading questions...</p>
            ) : questions.length > 0 ? (
              <>
                {questions.map((q, idx) => (
                  <QuestionCard key={`${q.id}-${idx}`} question={q} settings={settings} />
                ))}
                <div id="scroll-sentinel" style={{ height: '20px', margin: '10px 0' }} />
                {hasMore && (
                  <div style={{ padding: '2rem', textAlign: 'center' }}>
                    <p style={{ color: '#666', fontSize: '0.8rem' }}>{isFetchingMore ? "Loading more..." : "Scroll for more"}</p>
                  </div>
                )}
              </>
            ) : (
              <p style={{ textAlign: 'center', padding: '2rem' }}>No results match your filters.</p>
            )}
          </main>
          <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} settings={settings} onSettingChange={handleSettingChange} />
        </>
      )}
    </div>
  );
}

function FilterBar({ collegeOptions, subjectOptions, typeOptions, yearOptions, selInst, setSelInst, selSub, setSelSub, selType, setSelType, selYear, setSelYear, onClear }: { collegeOptions: string[]; subjectOptions: string[]; typeOptions: string[]; yearOptions: string[]; selInst: string[]; setSelInst: React.Dispatch<React.SetStateAction<string[]>>; selSub: string[]; setSelSub: React.Dispatch<React.SetStateAction<string[]>>; selType: string[]; setSelType: React.Dispatch<React.SetStateAction<string[]>>; selYear: string[]; setSelYear: React.Dispatch<React.SetStateAction<string[]>>; onClear: () => void }) {
  const [modal, setModal] = useState<string | null>(null);
  
  const toggle = (setter: React.Dispatch<React.SetStateAction<string[]>>, val: string) => {
    setter((prev: string[]) => prev.includes(val) ? prev.filter(i => i !== val) : [...prev, val]);
  };

  const label = (l: string, s: string[]) => s.length === 0 ? l : (s.length === 1 ? s[0] : `${s[0]} +${s.length - 1}`);

  const hasAnyFilter = selInst.length > 0 || selSub.length > 0 || selType.length > 0 || selYear.length > 0;

  return (
    <div className="filter-row" style={{ gridTemplateColumns: hasAnyFilter ? 'repeat(4, 1fr) 40px' : 'repeat(4, 1fr)' }}>
      <button className={`filter-btn ${selInst.length ? 'active' : ''}`} onClick={() => setModal('Inst')}>{label('Inst', selInst)} ▾</button>
      <button className={`filter-btn ${selSub.length ? 'active' : ''}`} onClick={() => setModal('Subj')}>{label('Subj', selSub)} ▾</button>
      <button className={`filter-btn ${selType.length ? 'active' : ''}`} onClick={() => setModal('Type')}>{label('Type', selType)} ▾</button>
      <button className={`filter-btn ${selYear.length ? 'active' : ''}`} onClick={() => setModal('Year')}>{label('Year', selYear)} ▾</button>
      {hasAnyFilter && <button className="filter-btn" onClick={onClear} title="Clear all" style={{ color: 'var(--wrong)' }}>✕</button>}

      {modal === 'Inst' && <MultiSelectModal title="College" options={collegeOptions} selected={selInst} onToggle={(v:string) => toggle(setSelInst, v)} onSelectAll={() => setSelInst(collegeOptions)} onClear={() => setSelInst([])} onClose={() => setModal(null)} />}
      {modal === 'Subj' && <MultiSelectModal title="Subject" options={subjectOptions} selected={selSub} onToggle={(v:string) => toggle(setSelSub, v)} onSelectAll={() => setSelSub(subjectOptions)} onClear={() => setSelSub([])} onClose={() => setModal(null)} />}
      {modal === 'Type' && <MultiSelectModal title="Type" options={typeOptions} selected={selType} onToggle={(v:string) => toggle(setSelType, v)} onSelectAll={() => setSelType(typeOptions)} onClear={() => setSelType([])} onClose={() => setModal(null)} />}
      {modal === 'Year' && <MultiSelectModal title="Year" options={yearOptions} selected={selYear} onToggle={(v:string) => toggle(setSelYear, v)} onSelectAll={() => setSelYear(yearOptions)} onClear={() => setSelYear([])} onClose={() => setModal(null)} />}
    </div>
  );
}

function QuestionCard({ question, isAdmin = false, onUpdateField, settings }: { question: Question; isAdmin?: boolean; onUpdateField?: (f: keyof Question, v: any) => void; settings?: Settings }) {
  const [sel, setSel] = useState<number | null>(null);
  
  // States that need to sync with settings/isAdmin
  const [sol, setSol] = useState(false);
  const [optRevealed, setOptRevealed] = useState(true);
  const [ansRevealed, setAnsRevealed] = useState(false);

  // Sync state when settings or isAdmin changes
  useEffect(() => {
    if (isAdmin) {
      setOptRevealed(true);
      setAnsRevealed(false);
      setSol(false);
    } else if (settings) {
      setOptRevealed(settings.showOpt);
      setAnsRevealed(settings.showAns);
      setSol(settings.showExp);
    }
  }, [isAdmin, settings]);

  // Reset local selection when question changes
  useEffect(() => {
    setSel(null);
  }, [question.id]);

  const handleOptionClick = (idx: number) => {
    if (isAdmin) return;
    // Allow selection if no option is selected OR if the answer is currently hidden
    if (sel === null || !ansRevealed) {
      setSel(idx);
      setAnsRevealed(true);
      if (settings?.autoExp) { setSol(true); }
    }
  };

  const showLabel = !!question.stimulus || (question.parts && question.parts.length > 1);

  return (
    <div className={`card ${question.hidden ? 'read' : ''}`}>
      <div className="card-meta">
        <span className="badge" style={{ background: SUBJECT_COLORS[question.subject] || '#666', color: 'white' }}>{question.subject}</span>
        <span className="badge" style={{ background: '#f1f5f9' }}>{question.institution} • {question.year}</span>
        {question.serial && <span className="badge" style={{ background: '#e2e8f0', color: '#475569', fontWeight: 700 }}>#{question.serial}</span>}
      </div>
      <EditableText className="card-header-main" text={question.type === 'mcq' ? (question.question || "") : (question.stimulus || "")} isEditable={isAdmin} onSave={(v:string) => onUpdateField?.(question.type === 'mcq' ? 'question' : 'stimulus', v)} />
      {question.type === 'mcq' ? (
        <>
          {(optRevealed || isAdmin) && (
            <div className="section">
              {question.options?.map((opt: string, i: number) => {
                let cl = 'option';
                // Highlight only if answer is revealed or in admin preview
                if (ansRevealed || isAdmin) {
                  if (i === question.answer_index) cl += ' correct-reveal';
                  else if (i === sel) cl += ' wrong-reveal';
                }
                // Option is disabled only if an answer is already being revealed and it's not admin
                const isInteractionDisabled = ansRevealed && !isAdmin;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {isAdmin && (
                      <input 
                        type="radio" 
                        name={`q-${question.id}-ans`} 
                        checked={question.answer_index === i} 
                        onChange={() => onUpdateField?.('answer_index', i)}
                        title="Set as correct answer"
                        style={{ cursor: 'pointer', width: '18px', height: '18px' }}
                      />
                    )}
                    <button className={cl} onClick={() => handleOptionClick(i)} disabled={isInteractionDisabled} style={{ flex: 1 }}>
                      <strong>{String.fromCharCode(65+i)})</strong>
                      <EditableText text={opt} isEditable={isAdmin} style={{ flex: 1, marginLeft: '0.5rem' }} onSave={(v:string) => { const o = [...(question.options || [])]; o[i] = v; onUpdateField?.('options', o); }} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {(ansRevealed && !optRevealed && !isAdmin) && (
            <div className="section">
              <div className="section-title">Correct Answer</div>
              <div style={{ fontWeight: 600, color: '#166534', padding: '0.75rem', background: 'var(--correct-bg)', borderRadius: '8px', border: '1px solid var(--correct)', fontSize: '0.9rem' }}>
                <strong>{String.fromCharCode(65 + (question.answer_index || 0))}) </strong>
                <EditableText 
                  text={question.options?.[question.answer_index || 0] || ""} 
                  isEditable={false} 
                  style={{ display: 'inline' }} 
                  onSave={() => {}}
                />
              </div>
            </div>
          )}
          {(sol || isAdmin) && question.explanation && <div className="section"><div className="section-title">Explanation</div><EditableText text={question.explanation} isEditable={isAdmin} style={{ fontSize: '0.9rem', color: '#374151' }} onSave={(v:string) => onUpdateField?.('explanation', v)} /></div>}
        </>
      ) : (
        <>
          <div className="section">
            {(question.parts || []).map((p: { label: string; question: string; mark: number }, i: number) => (
              <div key={i} className="cq-part">
                {showLabel && <strong>{p.label || "?"})</strong>}
                <EditableText text={p.question || ""} isEditable={isAdmin} style={{ display: 'inline', marginLeft: showLabel ? '0.5rem' : '0' }} onSave={(v:string) => { const pts = [...(question.parts || [])]; pts[i] = { ...pts[i], question: v }; onUpdateField?.('parts', pts); }} />
                <span style={{ fontSize: '0.7rem', color: '#666', marginLeft: '0.5rem' }}>[{p.mark || 0}]</span>
              </div>
            ))}
            {isAdmin && (!question.parts || question.parts.length === 0) && !question.stimulus && <p style={{ color: 'var(--wrong)', fontSize: '0.8rem' }}>⚠️ Missing parts and stimulus</p>}
          </div>
          {(sol || isAdmin) && <div className="section"><div className="section-title">Solution</div><EditableText text={question.solution || ""} isEditable={isAdmin} style={{ fontSize: '0.9rem', color: '#374151' }} onSave={(v:string) => onUpdateField?.('solution', v)} /></div>}
        </>
      )}
      {!isAdmin && (
        question.type === 'mcq' ? (
          <div className="card-footer">
            <button className={`toggle-btn ${optRevealed ? 'active' : ''}`} onClick={() => setOptRevealed(!optRevealed)}><span>📝</span> Options</button>
            <button className={`toggle-btn ${ansRevealed ? 'active' : ''}`} onClick={() => {
              const newVal = !ansRevealed;
              setAnsRevealed(newVal);
              if (!newVal) setSol(false);
            }}><span>🎯</span> Answer</button>
            <button className={`toggle-btn ${sol ? 'active' : ''}`} onClick={() => {
              const newVal = !sol;
              setSol(newVal);
              if (newVal) setAnsRevealed(true);
            }}><span>💡</span> Explain</button>
          </div>
        ) : (
          <div className="sq-footer" onClick={() => setSol(!sol)}><span style={{ color: sol ? 'var(--primary)' : 'var(--text-muted)', fontWeight: 700, fontSize: '0.85rem' }}>{sol ? '💡 Hide Solution' : '💡 View Solution'}</span></div>
        )
      )}
    </div>
  );
}

function AdminDashboard({ 
  questions, 
  onUpdate, 
  onExit,
  collegeOptions,
  subjectOptions,
  typeOptions,
  yearOptions,
  selInst, setSelInst,
  selSub, setSelSub,
  selType, setSelType,
  selYear, setSelYear,
  onClear,
  loadMore,
  hasMore,
  isLoadingMore,
  totalCount,
  filteredCount
}: { 
  questions: Question[]; 
  onUpdate: (qs: Question[]) => void; 
  onExit: () => void;
  collegeOptions: string[];
  subjectOptions: string[];
  typeOptions: string[];
  yearOptions: string[];
  selInst: string[]; setSelInst: React.Dispatch<React.SetStateAction<string[]>>;
  selSub: string[]; setSelSub: React.Dispatch<React.SetStateAction<string[]>>;
  selType: string[]; setSelType: React.Dispatch<React.SetStateAction<string[]>>;
  selYear: string[]; setSelYear: React.Dispatch<React.SetStateAction<string[]>>;
  onClear: () => void;
  loadMore: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  totalCount: number;
  filteredCount: number;
}) {
  const [jsonInput, setJsonInput] = useState("");
  const [error, setError] = useState("");
  const [previewQuestions, setPreviewQuestions] = useState<Question[]>([]);

  const copyPrompt = async () => {
    try {
      const res = await fetch('/question-prompt-template.md');
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      alert("Prompt template copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy prompt:", err);
      alert("Failed to copy prompt template.");
    }
  };

  // Font Management
  const [fontBn, setFontBn] = useState("'Noto Serif Bengali', serif");
  const [fontEn, setFontEn] = useState("'Times New Roman', serif");

  useEffect(() => {
    const fetchSettings = async () => {
      const { data, error: settingsError } = await supabase.from('settings').select('*').single();
      if (data && !settingsError) {
        setFontBn(data.font_bn);
        setFontEn(data.font_en);
      }
    };
    fetchSettings();
  }, []);

  const saveSettings = async () => {
    const { error: upsertError } = await supabase
      .from('settings')
      .upsert({ id: 1, font_bn: fontBn, font_en: fontEn });
    if (upsertError) alert("Error saving settings: " + upsertError.message);
    else alert("Global settings saved!");
  };

  const handleBulkUpload = async () => {
    if (!previewQuestions.length) {
      alert("Please update preview first to validate your JSON.");
      return;
    }
    
    // Schema now matches perfectly
    const toSave = previewQuestions;

    const { data, error: insertError } = await supabase.from('questions').insert(toSave).select();
    if (insertError) alert("Error saving questions: " + insertError.message);
    else {
      alert("Questions saved to Supabase!");
      if (data) {
        onUpdate(sortQuestions([...questions, ...data]));
      }
      setJsonInput("");
      setPreviewQuestions([]);
    }
  };

  const processJson = () => {
    if (!jsonInput.trim()) {
      setPreviewQuestions([]);
      setError("");
      return;
    }
    try {
      const parsed = JSON.parse(jsonInput);
      setPreviewQuestions(Array.isArray(parsed) ? parsed : [parsed]);
      setError("");
    } catch {
      setError("Invalid JSON");
      setPreviewQuestions([]);
    }
  };

  const handleJsonEditRequest = (q: Question) => {
    setJsonInput(JSON.stringify(q, null, 2));
    setPreviewQuestions([q]);
    setError("");
    window.scrollTo(0,0);
  };

  return (
    <div className="admin-layout">
      {/* Left Column: Question List */}
      <div className="admin-question-list-column">
        <div className="admin-header">
          <div>
            <h3 style={{ margin: 0 }}>Admin Portal</h3>
            <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '4px' }}>
              Total Questions in DB: <strong>{totalCount}</strong>
            </p>
          </div>
          <button className="btn btn-secondary" onClick={onExit}>Exit Admin</button>
        </div>
        
        <div className="sticky-filter-section">
          <div style={{ marginBottom: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h4 style={{ margin: 0 }}>Active Filters (<strong>{filteredCount}</strong> matches found)</h4>
            { (selInst.length > 0 || selSub.length > 0 || selType.length > 0 || selYear.length > 0) && (
              <button className="btn-text" onClick={onClear} style={{ fontSize: '0.7rem', color: 'var(--wrong)' }}>Clear All</button>
            )}
          </div>
          <FilterBar 
            collegeOptions={collegeOptions}
            subjectOptions={subjectOptions}
            typeOptions={typeOptions}
            yearOptions={yearOptions}
            selInst={selInst} setSelInst={setSelInst}
            selSub={selSub} setSelSub={setSelSub}
            selType={selType} setSelType={setSelType}
            selYear={selYear} setSelYear={setSelYear}
            onClear={onClear}
          />
        </div>

        <div className="admin-cards-view">
          {questions.map((q: Question, idx: number) => (
            <div key={`${q.id}-${idx}`} className="admin-card-wrapper">
              <div className="admin-card-actions">
                <button 
                  className={`btn ${q.hidden ? 'btn-secondary' : 'btn-primary'}`} 
                  style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
                  onClick={() => onUpdate(questions.map((item: Question) => item.id === q.id ? { ...item, hidden: !item.hidden } : item))}
                >
                  {q.hidden ? '👁️ Show' : '🚫 Hide'}
                </button>
                <button 
                  className="btn btn-secondary" 
                  style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
                  onClick={() => handleJsonEditRequest(q)}
                >
                  ✏️ Edit JSON
                </button>
                {q.hidden && <span className="hidden-badge">HIDDEN</span>}
              </div>
              <QuestionCard 
                question={q} 
                isAdmin={true} 
                settings={DEFAULT_SETTINGS} 
                onUpdateField={async (f, v) => {
                  const updatedQuestion = { ...q, [f]: v };
                  const { error: updateError } = await supabase
                    .from('questions')
                    .update({ [f]: v })
                    .eq('id', q.id);
                  
                  if (updateError) {
                    alert("Error saving change: " + updateError.message);
                  } else {
                    onUpdate(questions.map(item => item.id === q.id ? updatedQuestion : item));
                  }
                }}
              />
            </div>
          ))}
          <div id="scroll-sentinel" style={{ height: '20px', margin: '10px 0' }} />
          {hasMore && (
            <div style={{ padding: '1rem', textAlign: 'center' }}>
              <p style={{ color: '#666', fontSize: '0.8rem' }}>{isLoadingMore ? "Loading more..." : "Scroll for more"}</p>
            </div>
          )}
          {questions.length === 0 && !isLoadingMore && <p style={{ textAlign: 'center', padding: '2rem', color: '#666' }}>No questions match your filters.</p>}
        </div>
      </div>

      {/* Right Column: Editor and Preview */}
      <div className="admin-editor-column">
        <div className="admin-section">
          <h4>Typography Settings</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>Bengali Font</label>
              <select className="edit-input" value={fontBn} onChange={e => setFontBn(e.target.value)}>
                <option value="'Noto Serif Bengali', serif">Noto Serif Bengali</option>
                <option value="'Kalpurush', sans-serif">Kalpurush</option>
                <option value="'SolaimanLipi', sans-serif">SolaimanLipi</option>
                <option value="'Hind Siliguri', sans-serif">Hind Siliguri</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>English Font</label>
              <select className="edit-input" value={fontEn} onChange={e => setFontEn(e.target.value)}>
                <option value="'Times New Roman', serif">Times New Roman</option>
                <option value="'Inter', sans-serif">Inter</option>
                <option value="'Arial', sans-serif">Arial</option>
                <option value="'Georgia', serif">Georgia</option>
                <option value="'Courier New', monospace">Courier New</option>
              </select>
            </div>
          </div>
          <button className="btn btn-primary" onClick={saveSettings}>Save Global Typography</button>
        </div>

        <div className="admin-section" style={{ display: 'flex', flexDirection: 'column', minHeight: '400px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h4 style={{ margin: 0 }}>JSON Editor</h4>
            <button className="btn btn-secondary" onClick={copyPrompt} style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}>📋 Copy Prompt</button>
          </div>
          <textarea 
            className="json-textarea" 
            placeholder="Paste JSON here..." 
            value={jsonInput} 
            onChange={e => setJsonInput(e.target.value)}
            style={{ flex: 1, minHeight: '250px' }}
          />
          {error && <p className="error-msg">{error}</p>}
          <div className="admin-actions">
            <button className="btn btn-primary" onClick={processJson}>🔄 Update Preview</button>
            <button className="btn btn-primary" onClick={handleBulkUpload} disabled={!previewQuestions.length}>💾 Save to Database</button>
            <button className="btn btn-secondary" onClick={() => { setJsonInput(""); setPreviewQuestions([]); setError(""); }}>Reset</button>
          </div>
        </div>
        
        <div className="preview-panel">
          <span className="preview-label">Live Preview</span>
          <div className="content-feed">
            {previewQuestions.map((q, i) => (
              <div key={i} className="admin-card-wrapper">
                <QuestionCard 
                  question={q} 
                  isAdmin 
                  onUpdateField={(f: keyof Question, v: any) => { 
                    const u = [...previewQuestions]; 
                    u[i] = { ...u[i], [f]: v }; 
                    setPreviewQuestions(u); 
                    setJsonInput(JSON.stringify(u.length === 1 && !jsonInput.startsWith('[') ? u[0] : u, null, 2)); 
                  }} 
                />
                {q.id && (
                  <div style={{ padding: '0.5rem', display: 'flex', justifyContent: 'flex-end' }}>
                    <button 
                      className="btn btn-primary" 
                      style={{ fontSize: '0.75rem', padding: '0.25rem 0.75rem' }}
                      onClick={async () => {
                        const { error: updateError } = await supabase
                          .from('questions')
                          .update(q)
                          .eq('id', q.id);
                        
                        if (updateError) {
                          alert("Error saving: " + updateError.message);
                        } else {
                          alert("Saved successfully!");
                          onUpdate(questions.map(item => item.id === q.id ? q : item));
                        }
                      }}
                    >
                      💾 Save to Supabase
                    </button>
                  </div>
                )}
              </div>
            ))}
            {previewQuestions.length === 0 && <p style={{ textAlign: 'center', padding: '2rem', border: '2px dashed #e2e8f0', borderRadius: '12px', color: '#94a3b8' }}>Preview will appear here after clicking "Update Preview"</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
