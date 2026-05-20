import { Component, useState, useEffect, useCallback, useRef } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as Sentry from '@sentry/react'
import katex from 'katex'
import { supabase } from './supabaseClient'
import { feedback, setAdminFeedback, setUserFeedback } from './feedback'
import './App.css'
import './Admin.css'

/* ============ Error Boundary ============ */
// Catches any unexpected React render error and shows a Reload UI instead of
// the blank screen that in-app browsers tend to produce when something breaks
// deep in the tree.
interface EBState { error: Error | null }
export class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(error: Error): EBState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
    // Report to Sentry if configured (no-op when DSN absent).
    try {
      Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
    } catch { /* ignore — Sentry not initialized */ }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="error-screen">
          <div className="error-card">
            <h2>Something went wrong</h2>
            <p>The app hit an unexpected error. Try reloading. If it keeps happening, open this page in your phone's main browser (Chrome / Safari).</p>
            <button onClick={() => { try { localStorage.removeItem('studyGroup'); } catch {/*ignore*/} window.location.reload(); }}>Reload</button>
            <details>
              <summary>Details</summary>
              <pre>{this.state.error.message}</pre>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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

/* Bangla display names for subjects. The DB still stores the English values
   ('Physics', 'Chemistry', etc.) — these are display-only. Any subject not
   in the map falls back to its English name. */
const SUBJECT_BN: Record<string, string> = {
  Physics: 'পদার্থবিজ্ঞান',
  Chemistry: 'রসায়ন',
  Math: 'গণিত',
  Biology: 'জীববিজ্ঞান',
  English: 'ইংরেজি',
  GK: 'সাধারণ জ্ঞান',
  Bangla: 'বাংলা',
  ICT: 'আইসিটি',
  Accounting: 'হিসাববিজ্ঞান',
  'Business Entrepreneurship': 'ব্যবসায় উদ্যোগ',
  'Finance and Banking': 'ফিন্যান্স ও ব্যাংকিং',
  Civics: 'পৌরনীতি',
  History: 'ইতিহাস',
  Geography: 'ভূগোল',
  Economics: 'অর্থনীতি',
};
const displaySubject = (s: string) => SUBJECT_BN[s] ?? s;

// Bangla display names for institutions (DB keeps the short codes).
const INSTITUTION_BN: Record<string, string> = {
  NDC: 'নটর ডেম',
  HCC: 'হলিক্রস',
  SJHSS: 'সেন্ট যোসেফ',
};
const displayInstitution = (s: string) => INSTITUTION_BN[s] ?? s;

// Years shown in Bengali numerals (DB keeps Arabic). "Practice" -> অনুশীলন.
const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
function displayYear(y: string | number | undefined | null): string {
  const s = String(y ?? '');
  if (s.trim().toLowerCase() === 'practice') return 'অনুশীলন';
  return s.replace(/[0-9]/g, d => BN_DIGITS[+d]);
}

const SUBJECT_COLORS: Record<string, string> = {
  Physics: 'var(--color-physics)',
  Chemistry: 'var(--color-chemistry)',
  Math: 'var(--color-math)',
  Biology: 'var(--color-biology)',
  English: 'var(--color-english)',
  GK: 'var(--color-gk)',
  Bangla: 'var(--color-bangla)',
  ICT: 'var(--color-ict)',
  Accounting: 'var(--color-accounting)',
  'Business Entrepreneurship': 'var(--color-business)',
  'Finance and Banking': 'var(--color-finance)',
  Civics: 'var(--color-civics)',
  History: 'var(--color-history)',
  Geography: 'var(--color-geography)',
  Economics: 'var(--color-economics)',
};

/* ============ Study Group ============ */
type Group = 'science' | 'bst' | 'humanities';

const GROUP_LABELS: Record<Group, string> = {
  science: 'বিজ্ঞান',
  bst: 'ব্যবসায় শিক্ষা',
  humanities: 'মানবিক',
};

const GROUP_SUBJECTS: Record<Group, string[]> = {
  // The order in each array IS the display + sort order on the feed.
  // Subject names must match the DB exactly (intersected against the live
  // subject list, so a name with no rows simply won't appear in the modal).
  science:    ['Physics', 'Chemistry', 'Biology', 'Math', 'ICT', 'Bangla', 'English', 'GK'],
  bst:        ['Accounting', 'Business Entrepreneurship', 'Finance and Banking', 'Math', 'ICT', 'Bangla', 'English', 'GK'],
  humanities: ['Civics', 'History', 'Geography', 'Economics', 'Math', 'ICT', 'Bangla', 'English', 'GK'],
};

// Used for two purposes: display order on the student feed, and the
// allowlist of institutions visible to students. Questions with any other
// institution value (e.g. 'Unknown' — legacy data that admin still curates)
// are hidden from the student-side filter dropdown and excluded from the
// default feed. Admin sees the full set.
const INSTITUTION_ORDER = ['NDC', 'HCC', 'SJHSS'];

function isGroup(v: unknown): v is Group {
  return v === 'science' || v === 'bst' || v === 'humanities';
}

/* ============ Saved filters (persisted per student in student_progress) ============ */
type SavedFilters = { inst: string[]; sub: string[]; type: string[]; year: string[] };

function parseFilters(f: unknown): SavedFilters {
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const o = (f && typeof f === 'object') ? f as Record<string, unknown> : {};
  return { inst: arr(o.inst), sub: arr(o.sub), type: arr(o.type), year: arr(o.year) };
}

interface Settings {
  autoExp: boolean;
  showOpt: boolean;
  showAns: boolean;
  showExp: boolean;
}

const DEFAULT_SETTINGS: Settings = { autoExp: false, showOpt: true, showAns: false, showExp: false };

type Theme = 'dark' | 'light' | 'system';

function readBoolPref(key: string, def: boolean): boolean {
  if (typeof window === 'undefined') return def;
  try { const v = localStorage.getItem(key); return v === null ? def : v === '1'; } catch { return def; }
}
function writeBoolPref(key: string, val: boolean) {
  try { localStorage.setItem(key, val ? '1' : '0'); } catch { /* ignore */ }
}

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') {
    root.removeAttribute('data-theme');
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    if (prefersLight) root.setAttribute('data-theme', 'light');
  } else if (t === 'light') {
    root.setAttribute('data-theme', 'light');
  } else {
    root.removeAttribute('data-theme');
  }
}

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
  // Strip a leading serial marker only when it's a number followed by a
  // separator (. ) ।) AND then whitespace — e.g. "1. ", "24) ", "১০। ".
  // Requiring the trailing space avoids eating legitimate content like
  // "5 grams" (number + space, no separator) or "1.5 kg" (decimal — the
  // char after "." is a digit, not a space).
  return t.replace(/^\s*[\d০-৯]+[.।)]+\s+/, "").trim();
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

// Wrap every occurrence of `query` in <mark>, in the text portions of the
// already-rendered HTML only (so we don't break KaTeX spans or HTML tags).
function highlightInHTML(html: string, query: string): string {
  if (!query || !query.trim()) return html;
  const q = query.trim();
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  // Tokenize: each match is either an HTML tag or a run of text between tags.
  return html.replace(/(<[^>]+>)|([^<]+)/g, (_full, tag, text) => {
    if (tag) return tag;
    return text.replace(re, '<mark>$1</mark>');
  });
}

/* ============ Icons (inline SVG) ============ */
const I = {
  Gear: ({ size = 18 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  Close: ({ size = 16 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  Chevron: ({ size = 12 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  Check: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  X: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  List: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="8" x2="21" y1="6" y2="6" />
      <line x1="8" x2="21" y1="12" y2="12" />
      <line x1="8" x2="21" y1="18" y2="18" />
      <line x1="3" x2="3.01" y1="6" y2="6" />
      <line x1="3" x2="3.01" y1="12" y2="12" />
      <line x1="3" x2="3.01" y1="18" y2="18" />
    </svg>
  ),
  Target: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  ),
  Bulb: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2z" />
    </svg>
  ),
  Inbox: ({ size = 44 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  Sun: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  ),
  Moon: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  Monitor: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  ),
  LogOut: ({ size = 14 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </svg>
  ),
  Search: ({ size = 18 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  ),
  Undo: ({ size = 16 }: { size?: number } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  ),
  Flag: ({ size = 15, filled = false }: { size?: number; filled?: boolean } = {}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" x2="4" y1="22" y2="15" />
    </svg>
  ),
};

/* ============ Student info (passed via URL on first visit) ============ */
type StudentInfo = { name: string; phone: string };
const STUDENT_KEY = 'student';

function readStudent(): StudentInfo | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STUDENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.name === 'string' && typeof parsed.phone === 'string') return parsed;
    return null;
  } catch { return null; }
}

function captureStudentFromURL(): StudentInfo | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const name = params.get('name');
  const phone = params.get('phone');
  if (!name || !phone) return null;
  const info: StudentInfo = { name: name.trim(), phone: phone.trim() };
  localStorage.setItem(STUDENT_KEY, JSON.stringify(info));
  // Strip from URL so the personal info doesn't get bookmarked / re-shared.
  params.delete('name');
  params.delete('phone');
  const newSearch = params.toString();
  const url = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
  window.history.replaceState(null, '', url);
  return info;
}

function firstName(full: string): string {
  const trimmed = full.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

/* ============ Editable text ============ */
function EditableText({ text, onSave, className = "", isEditable = false, style = {}, highlight = '' }: { text: string; onSave: (v: string) => void; className?: string; isEditable?: boolean; style?: React.CSSProperties; highlight?: string }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(text);

  if (isEditable && editing) return <textarea className="edit-input" value={val} onChange={e => setVal(e.target.value)} onBlur={() => { setEditing(false); onSave(val); }} autoFocus />;
  return <div className={`${className} ${isEditable ? 'editable-field' : ''}`} style={style} onClick={() => { if (isEditable) { setEditing(true); setVal(text); } }} dangerouslySetInnerHTML={{ __html: highlightInHTML(renderMath(text), highlight) }} />;
}

/* ============ Multi-select bottom-sheet modal ============ */
function MultiSelectModal({ title, options, selected, onToggle, onClose, onSelectAll, onClear, getDisplay }: { title: string; options: string[]; selected: string[]; onToggle: (v: string) => void; onClose: () => void; onSelectAll: () => void; onClear: () => void; getDisplay?: (v: string) => string }) {
  // Portal to body so `position: fixed` is relative to the viewport, not to
  // .sticky-top (which has backdrop-filter and would otherwise become the
  // containing block, anchoring the sheet to the top of the screen).
  const display = (v: string) => (getDisplay ? getDisplay(v) : v);
  return createPortal(
    <div className="modal-overlay" style={{ zIndex: 1200 }} onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-handle" />
        <div className="modal-header">
          <h3>{title} বাছাই</h3>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button className="filter-btn" style={{ padding: '0.35rem 0.7rem', fontSize: '0.76rem' }} onClick={onSelectAll}>সব</button>
            <button className="filter-btn" style={{ padding: '0.35rem 0.7rem', fontSize: '0.76rem' }} onClick={onClear}>মুছে দাও</button>
            <button className="filter-btn" style={{ padding: '0.35rem 0.85rem', fontSize: '0.76rem', background: 'var(--correct)', borderColor: 'var(--correct)', color: 'white' }} onClick={onClose} aria-label="Done"><I.Check size={16} /></button>
          </div>
        </div>
        <div className="option-grid">
          {options.length > 0 ? options.map((opt: string) => (
            <div key={opt} className={`checkbox-item ${selected.includes(opt) ? 'selected' : ''}`} onClick={() => onToggle(opt)}>{display(opt)}</div>
          )) : <p style={{ gridColumn: '1/-1', textAlign: 'center', padding: '1rem', color: 'var(--text-muted)' }}>কোন অপশন নেই</p>}
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ============ Sidebar ============ */
function Sidebar({ isOpen, onClose, settings, onSettingChange, theme, onThemeChange, group, onChangeGroup, userHaptics, userSound, onFeedbackChange }: { isOpen: boolean; onClose: () => void; settings: Settings; onSettingChange: (key: keyof Settings, val: boolean) => void; theme: Theme; onThemeChange: (t: Theme) => void; group: Group | null; onChangeGroup: () => void; userHaptics: boolean; userSound: boolean; onFeedbackChange: (key: 'haptics' | 'sound', val: boolean) => void }) {
  return (
    <>
      <div className={`modal-overlay ${isOpen ? 'open' : ''}`} style={{ display: isOpen ? 'block' : 'none', zIndex: 1050 }} onClick={onClose} />
      <div id="sidebar" className={isOpen ? 'open' : ''}>
        <div className="sidebar-header">
          <h3>Settings</h3>
          <button className="close-btn" onClick={onClose} aria-label="Close settings"><I.Close /></button>
        </div>

        {group && (
          <div className="sidebar-section">
            <div className="sidebar-label">Group</div>
            <div className="toggle-row">
              <span className="toggle-label" style={{ fontFamily: 'var(--font-bn), var(--font-en), serif' }}>{GROUP_LABELS[group]}</span>
              <button className="filter-btn" style={{ padding: '0.4rem 0.85rem', fontSize: '0.78rem' }} onClick={onChangeGroup}>Change</button>
            </div>
          </div>
        )}

        <div className="sidebar-section">
          <div className="sidebar-label">Appearance</div>
          <div className="theme-picker" role="radiogroup" aria-label="Theme">
            <button role="radio" aria-checked={theme === 'light'} className={theme === 'light' ? 'active' : ''} onClick={() => onThemeChange('light')}><I.Sun /> Light</button>
            <button role="radio" aria-checked={theme === 'dark'} className={theme === 'dark' ? 'active' : ''} onClick={() => onThemeChange('dark')}><I.Moon /> Dark</button>
            <button role="radio" aria-checked={theme === 'system'} className={theme === 'system' ? 'active' : ''} onClick={() => onThemeChange('system')}><I.Monitor /> Auto</button>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">Behavior</div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Auto-show Explanation</div>
              <div className="toggle-sub">Reveal after you pick an option</div>
            </div>
            <label className="switch"><input type="checkbox" checked={settings.autoExp} onChange={e => onSettingChange('autoExp', e.target.checked)} /><span className="slider"></span></label>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">Feedback</div>
          <div className="toggle-row">
            <span className="toggle-label">Haptics (vibration)</span>
            <label className="switch"><input type="checkbox" checked={userHaptics} onChange={e => onFeedbackChange('haptics', e.target.checked)} /><span className="slider"></span></label>
          </div>
          <div className="toggle-row">
            <span className="toggle-label">Sound</span>
            <label className="switch"><input type="checkbox" checked={userSound} onChange={e => onFeedbackChange('sound', e.target.checked)} /><span className="slider"></span></label>
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">Global toggles</div>
          <div className="toggle-row">
            <span className="toggle-label">Options</span>
            <label className="switch"><input type="checkbox" checked={settings.showOpt} onChange={e => onSettingChange('showOpt', e.target.checked)} /><span className="slider"></span></label>
          </div>
          <div className="toggle-row">
            <span className="toggle-label">Correct Answer</span>
            <label className="switch"><input type="checkbox" checked={settings.showAns} onChange={e => onSettingChange('showAns', e.target.checked)} /><span className="slider"></span></label>
          </div>
          <div className="toggle-row">
            <span className="toggle-label">Explanation</span>
            <label className="switch"><input type="checkbox" checked={settings.showExp} onChange={e => onSettingChange('showExp', e.target.checked)} /><span className="slider"></span></label>
          </div>
        </div>
      </div>
    </>
  );
}

/* ============ Group selector ============ */
function GroupSelector({ onSelect, onCancel, currentGroup }: { onSelect: (g: Group) => void; onCancel?: () => void; currentGroup?: Group | null }) {
  return (
    <div className="group-selector">
      <div className="group-card-wrap">
        <div className="group-title">কোন গ্রুপের প্রস্তুতি নিচ্ছো?</div>
        <div className="group-sub">Choose your stream to tailor your feed.</div>
        <div className="group-cards">
          {(Object.keys(GROUP_LABELS) as Group[]).map(g => (
            <button key={g} className={`group-card ${g === currentGroup ? 'group-card-current' : ''}`} onClick={() => onSelect(g)}>
              <span>
                {GROUP_LABELS[g]}
                <span className="group-card-sub">{GROUP_SUBJECTS[g].slice(0, 4).map(displaySubject).join(' · ')}{GROUP_SUBJECTS[g].length > 4 ? ' …' : ''}</span>
              </span>
              <span className="group-card-arrow">{g === currentGroup ? <I.Check size={18} /> : <I.Chevron size={16} />}</span>
            </button>
          ))}
        </div>
        {onCancel && (
          <button type="button" className="auth-back" onClick={onCancel}>← Back</button>
        )}
      </div>
    </div>
  );
}

/* ============ Skeleton loader ============ */
function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <div className="skeleton-row" style={{ width: '60px' }} />
        <div className="skeleton-row" style={{ width: '120px' }} />
        <div className="skeleton-row" style={{ width: '36px', marginLeft: 'auto' }} />
      </div>
      <div className="skeleton-row" style={{ width: '85%', height: '16px' }} />
      <div className="skeleton-row" style={{ width: '70%', height: '16px' }} />
      <div className="skeleton-row tall" />
      <div className="skeleton-row tall" />
    </div>
  );
}

/* ============ Admin session (custom — not Supabase Auth) ============ */
// Password is kept so we can re-verify on every admin write via the Edge
// Function. localStorage is XSS-exposed; this is the trade-off we picked for
// "re-send credentials each call" instead of a session-token table.
type AdminSession = { id: string; username: string; password: string };
const ADMIN_SESSION_KEY = 'adminSession';

function readAdminSession(): AdminSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ADMIN_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === 'string' && typeof parsed.username === 'string' && typeof parsed.password === 'string') return parsed;
    return null;
  } catch { return null; }
}

/* ============ Admin proxy caller (Supabase Edge Function) ============ */
type AdminResult<T = unknown> = { data?: T; error?: string };

async function callAdmin<T = unknown>(op: string, payload: unknown, creds: { username: string; password: string }): Promise<AdminResult<T>> {
  try {
    const { data, error } = await supabase.functions.invoke('admin-op', {
      body: { username: creds.username, password: creds.password, op, payload },
    });
    if (error) {
      // Try to surface the JSON error returned by our function (supabase-js
      // wraps non-2xx responses in FunctionsHttpError).
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') {
        try {
          const parsed = await ctx.json();
          if (parsed && typeof parsed.error === 'string') return { error: parsed.error };
        } catch { /* fall through */ }
      }
      return { error: error.message || 'Network error' };
    }
    if (data && typeof data === 'object' && 'error' in data && (data as { error?: unknown }).error) {
      return { error: String((data as { error: unknown }).error) };
    }
    const payloadOut = (data && typeof data === 'object' && 'data' in data) ? (data as { data: T }).data : (data as T);
    return { data: payloadOut };
  } catch (e) {
    return { error: (e as Error).message || 'Network error' };
  }
}

/* ============ Admin login + signup ============ */
function AdminLogin({ onCancel, onSuccess }: { onCancel: () => void; onSuccess: (s: AdminSession) => void }) {
  const [mode, setMode] = useState<'signin' | 'create'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSignin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { data, error } = await supabase.rpc('admin_login', { p_username: username, p_password: password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.id) {
      setErr('Invalid username or password.');
      return;
    }
    const session: AdminSession = { id: row.id, username: row.username, password };
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
    onSuccess(session);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { data, error } = await supabase.rpc('admin_signup', {
      p_admin_key: adminKey,
      p_username: username,
      p_password: password,
    });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    if (!data) {
      setErr('Sign-up failed.');
      return;
    }
    const session: AdminSession = { id: String(data), username: username.toLowerCase().trim(), password };
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
    onSuccess(session);
  };

  const switchMode = (next: 'signin' | 'create') => {
    setErr('');
    setPassword('');
    setAdminKey('');
    setMode(next);
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={mode === 'signin' ? handleSignin : handleCreate}>
        <h2>{mode === 'signin' ? 'Admin Sign In' : 'Create Admin'}</h2>
        <p className="auth-sub">
          {mode === 'signin'
            ? 'Sign in with your admin credentials.'
            : 'Use the admin signup key to create a new admin account.'}
        </p>

        {mode === 'create' && (
          <div>
            <label htmlFor="auth-key">Admin Key</label>
            <input id="auth-key" type="password" autoComplete="off" required value={adminKey} onChange={e => setAdminKey(e.target.value)} />
          </div>
        )}
        <div>
          <label htmlFor="auth-username">Username</label>
          <input id="auth-username" type="text" autoCapitalize="none" autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} />
        </div>
        <div>
          <label htmlFor="auth-pwd">Password</label>
          <input id="auth-pwd" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} required value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        {err && <div className="auth-err">{err}</div>}
        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : (mode === 'signin' ? 'Sign In' : 'Create Admin')}
        </button>

        <div className="auth-switch">
          {mode === 'signin' ? (
            <button type="button" className="auth-back" onClick={() => switchMode('create')}>
              Need to create an admin? →
            </button>
          ) : (
            <button type="button" className="auth-back" onClick={() => switchMode('signin')}>
              ← Have an account? Sign in
            </button>
          )}
        </div>
        <button type="button" className="auth-back" onClick={onCancel}>← Back to questions</button>
      </form>
    </div>
  );
}

/* ============ App ============ */
function App() {
  // Theme state (academic dark-first; persisted to localStorage)
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'dark';
    return (localStorage.getItem('theme') as Theme) || 'dark';
  });

  // Per-student feedback preferences (within what the admin globally allows).
  const [userHaptics, setUserHaptics] = useState<boolean>(() => readBoolPref('fbHaptics', true));
  const [userSound, setUserSound] = useState<boolean>(() => readBoolPref('fbSound', true));
  useEffect(() => { setUserFeedback({ haptics: userHaptics, sound: userSound }); }, [userHaptics, userSound]);
  const handleFeedbackChange = (key: 'haptics' | 'sound', val: boolean) => {
    if (key === 'haptics') { setUserHaptics(val); writeBoolPref('fbHaptics', val); }
    else { setUserSound(val); writeBoolPref('fbSound', val); }
  };

  // Admin gating (custom — no Supabase Auth)
  const [wantsAdmin, setWantsAdmin] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).has('admin');
  });
  const [adminSession, setAdminSession] = useState<AdminSession | null>(() => readAdminSession());

  // Student study group (Bengali stream)
  // Group is NOT persisted locally — the picker shows on every app entry.
  // lastGroup (from Supabase) just pre-highlights the previous choice.
  const [studyGroup, setStudyGroup] = useState<Group | null>(null);
  const [lastGroup, setLastGroup] = useState<Group | null>(null);
  const [isChoosingGroup, setIsChoosingGroup] = useState(false);

  // Student identity (captured from ?name=&phone= in the URL on first hit;
  // setter intentionally omitted — captureStudentFromURL persists to
  // localStorage and the next reload picks up any new URL params).
  const [student] = useState<StudentInfo | null>(() => captureStudentFromURL() ?? readStudent());

  // Read/unread state for the current student. Persisted server-side in
  // public.student_progress as a single row per student (read_question_ids
  // is a deduplicated text[]). Toggles go through atomic RPCs so concurrent
  // writes can't clobber the array. Empty/unidentified students don't get
  // read tracking — swipe gesture is disabled for them.
  const [readSet, setReadSet] = useState<Set<string>>(new Set());
  // Questions this student has flagged as wrong/mistaken (student_progress).
  const [flaggedSet, setFlaggedSet] = useState<Set<string>>(new Set());

  // Filter selections (restored from / saved to student_progress.filters).
  const [selInst, setSelInst] = useState<string[]>([]);
  const [selSub, setSelSub] = useState<string[]>([]);
  const [selType, setSelType] = useState<string[]>([]);
  const [selYear, setSelYear] = useState<string[]>([]);
  // Gates the first feed fetch until saved filters load from the DB (avoids a
  // flash of unfiltered content).
  const [filtersRestored, setFiltersRestored] = useState(false);

  useEffect(() => {
    const phone = student?.phone;
    const admin = wantsAdmin && !!adminSession;
    // Admin view doesn't use read tracking or saved student filters.
    if (admin || !phone) {
      setReadSet(new Set());
      setFlaggedSet(new Set());
      setFiltersRestored(true);
      return;
    }
    let cancelled = false;
    supabase
      .from('student_progress')
      .select('read_question_ids, flagged_question_ids, filters, study_group')
      .eq('student_phone', phone)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) {
          const ids = (data as { read_question_ids?: string[] }).read_question_ids ?? [];
          setReadSet(new Set(ids));
          const flags = (data as { flagged_question_ids?: string[] }).flagged_question_ids ?? [];
          setFlaggedSet(new Set(flags));
          const f = parseFilters((data as { filters?: unknown }).filters);
          setSelInst(f.inst);
          setSelSub(f.sub);
          setSelType(f.type);
          setSelYear(f.year);
          const g = (data as { study_group?: unknown }).study_group;
          if (isGroup(g)) setLastGroup(g);
        }
        setFiltersRestored(true);
      });
    return () => { cancelled = true; };
  }, [student?.phone, wantsAdmin, adminSession]);

  // Persist the filter selection to the student's row (debounced). Skipped
  // until restore completes so the initial empty state can't overwrite it.
  useEffect(() => {
    const phone = student?.phone;
    const admin = wantsAdmin && !!adminSession;
    if (admin || !phone || !filtersRestored) return;
    const t = setTimeout(() => {
      supabase
        .from('student_progress')
        .upsert({ student_phone: phone, filters: { inst: selInst, sub: selSub, type: selType, year: selYear } })
        .then(({ error }) => { if (error) console.error('[saveFilters]', error); });
    }, 600);
    return () => clearTimeout(t);
  }, [selInst, selSub, selType, selYear, student?.phone, wantsAdmin, adminSession, filtersRestored]);

  const toggleRead = useCallback(async (questionId: string) => {
    const phone = student?.phone;
    if (!phone) return;
    const wasRead = readSet.has(questionId);
    // Optimistic local update.
    setReadSet(prev => {
      const next = new Set(prev);
      if (wasRead) next.delete(questionId); else next.add(questionId);
      return next;
    });
    const rpcName = wasRead ? 'unmark_question_read' : 'mark_question_read';
    const { error } = await supabase.rpc(rpcName, {
      p_phone: phone,
      p_question_id: questionId,
    });
    if (error) console.error(`[toggleRead] ${rpcName} failed`, error);
  }, [student?.phone, readSet]);

  const toggleFlag = useCallback(async (questionId: string) => {
    const phone = student?.phone;
    if (!phone) return;
    const wasFlagged = flaggedSet.has(questionId);
    feedback(wasFlagged ? 'tap' : 'toggle');
    setFlaggedSet(prev => {
      const next = new Set(prev);
      if (wasFlagged) next.delete(questionId); else next.add(questionId);
      return next;
    });
    const rpcName = wasFlagged ? 'unflag_question' : 'flag_question';
    const { error } = await supabase.rpc(rpcName, {
      p_phone: phone,
      p_question_id: questionId,
    });
    if (error) console.error(`[toggleFlag] ${rpcName} failed`, error);
  }, [student?.phone, flaggedSet]);

  // Native swipe-to-toggle-read on the student feed. We attach raw touch
  // listeners (not React synthetic events) because some Android WebViews and
  // in-app browsers don't propagate React's delegated touchmove/touchend
  // reliably — works in DevTools but fails on the actual phone.
  const feedRef = useRef<HTMLElement>(null);
  const toggleReadRef = useRef(toggleRead);
  useEffect(() => { toggleReadRef.current = toggleRead; }, [toggleRead]);

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;

    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let swipeCard: HTMLElement | null = null;
    let active = false;
    // Until the first ~6px of movement, we don't know if this is a horizontal
    // swipe (toggle read) or a vertical scroll. Wait, then commit. If vertical
    // dominates, release the card and let the browser scroll cleanly.
    type Dir = 'undecided' | 'horizontal' | 'vertical';
    let dir: Dir = 'undecided';
    const DIRECTION_LOCK_PX = 6;

    const onStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null;
      const card = target?.closest<HTMLElement>('.card') ?? null;
      if (!card) return;
      swipeCard = card;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      currentX = startX;
      active = true;
      dir = 'undecided';
      card.style.transition = 'none';
    };
    const onMove = (e: TouchEvent) => {
      if (!active || !swipeCard) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (dir === 'undecided') {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (ax < DIRECTION_LOCK_PX && ay < DIRECTION_LOCK_PX) return; // not enough yet
        if (ay >= ax) {
          // Vertical scroll. Hand the gesture back to the browser.
          dir = 'vertical';
          swipeCard.style.transform = '';
          active = false;
          swipeCard = null;
          return;
        }
        dir = 'horizontal';
      }

      currentX = t.clientX;
      swipeCard.style.transform = `translateX(${dx}px)`;
    };
    const onEnd = () => {
      if (!swipeCard) { active = false; dir = 'undecided'; return; }
      const card = swipeCard;
      const diffX = currentX - startX;
      card.style.transition = 'transform 0.4s cubic-bezier(0.25, 0.8, 0.25, 1), opacity 0.3s, filter 0.3s';
      card.style.transform = 'translateX(0)';
      if (dir === 'horizontal' && Math.abs(diffX) > 80) {
        // Toggle the class on the DOM synchronously (like the reference does)
        // so opacity/filter animate in the same frame as the snap-back.
        card.classList.toggle('read');
        feedback('toggle');
        const qid = card.getAttribute('data-question-id');
        if (qid) toggleReadRef.current(qid);
      }
      active = false;
      dir = 'undecided';
      swipeCard = null;
    };

    feed.addEventListener('touchstart', onStart, { passive: true });
    feed.addEventListener('touchmove', onMove, { passive: true });
    feed.addEventListener('touchend', onEnd);
    feed.addEventListener('touchcancel', onEnd);
    return () => {
      feed.removeEventListener('touchstart', onStart);
      feed.removeEventListener('touchmove', onMove);
      feed.removeEventListener('touchend', onEnd);
      feed.removeEventListener('touchcancel', onEnd);
    };
    // Re-run when the student-feed root mounts (i.e. after the group picker
    // dismisses and <main> appears). feedRef alone isn't a reactive dep.
  }, [studyGroup, adminSession, isChoosingGroup]);

  // Wobble the first card once per session — the consume-effect is wired
  // up below, after `questions` is declared.
  const [wobbleEnabled, setWobbleEnabled] = useState(() => {
    try { return sessionStorage.getItem('wobbleShown') !== '1'; } catch { return false; }
  });

  // Search (debounced)
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Announcement banner (driven by settings.banner_enabled / banner_message).
  // Auto-hides on first scroll. Re-renders on realtime settings updates.
  const [bannerEnabled, setBannerEnabled] = useState(false);
  const [bannerMessage, setBannerMessage] = useState('');
  const [announceVisible, setAnnounceVisible] = useState(true);
  useEffect(() => {
    if (!bannerEnabled) return;
    setAnnounceVisible(true);
    const onScroll = () => {
      if (window.scrollY > 24) setAnnounceVisible(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [bannerEnabled, bannerMessage]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);

  // Metadata
  const [collegeOptions, setCollegeOptions] = useState<string[]>([]);
  const [subjectOptions, setSubjectOptions] = useState<string[]>([]);
  const [typeOptions] = useState<string[]>(['MCQ', 'SQ']);
  const [yearOptions, setYearOptions] = useState<string[]>([]);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  const isAdmin = wantsAdmin && !!adminSession;

  // Apply theme + persist + listen to system changes
  useEffect(() => {
    // Admin shell needs light tokens regardless (admin styles assume light)
    if (isAdmin) {
      document.documentElement.setAttribute('data-theme', 'light');
      return;
    }
    applyTheme(theme);
    localStorage.setItem('theme', theme);
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const handler = () => applyTheme('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [theme, isAdmin]);

  const handleSignOut = useCallback(() => {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    setAdminSession(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('admin');
    window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    setWantsAdmin(false);
  }, []);

  const cancelAdminEntry = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('admin');
    window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    setWantsAdmin(false);
  }, []);

  // Fetch global settings (fonts), metadata for filters, total count
  useEffect(() => {
    const fetchSettings = async () => {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (data && !error) {
        if (data.font_bn) document.documentElement.style.setProperty('--font-bn', data.font_bn);
        if (data.font_en) document.documentElement.style.setProperty('--font-en', data.font_en);
        if (typeof data.banner_enabled === 'boolean') setBannerEnabled(data.banner_enabled);
        if (typeof data.banner_message === 'string') setBannerMessage(data.banner_message);
        setAdminFeedback({
          haptics: typeof data.haptics_enabled === 'boolean' ? data.haptics_enabled : undefined,
          sound: typeof data.sound_enabled === 'boolean' ? data.sound_enabled : undefined,
        });
      }
    };

    const fetchInitialData = async () => {
      const { count, error: countError } = await supabase.from('questions').select('*', { count: 'exact', head: true });
      if (!countError) setTotalCount(count || 0);

      let allMeta: { institution: string; subject: string; year: string }[] = [];
      let from = 0;
      const step = 1000;
      let moreMeta = true;
      while (moreMeta) {
        const { data, error: metaError } = await supabase
          .from('questions')
          .select('institution, subject, year')
          .range(from, from + step - 1);
        if (data && !metaError) {
          allMeta = [...allMeta, ...data];
          if (data.length < step) moreMeta = false;
          else from += step;
        } else {
          moreMeta = false;
        }
      }
      if (allMeta.length > 0) {
        setCollegeOptions(Array.from(new Set(allMeta.map(q => String(q.institution || "").trim()))).filter(Boolean).sort());
        setSubjectOptions(Array.from(new Set(allMeta.map(q => String(q.subject || "").trim()))).filter(Boolean).sort());
        setYearOptions(Array.from(new Set(allMeta.map(q => String(q.year || "").trim()))).filter(Boolean).sort().reverse());
      }
    };

    fetchSettings();
    fetchInitialData();

    const settingsSubscription = supabase
      .channel('public:settings')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, payload => {
        const row = payload.new as Record<string, unknown> | undefined;
        if (!row) return;
        if (typeof row.font_bn === 'string') document.documentElement.style.setProperty('--font-bn', row.font_bn);
        if (typeof row.font_en === 'string') document.documentElement.style.setProperty('--font-en', row.font_en);
        if (typeof row.banner_enabled === 'boolean') setBannerEnabled(row.banner_enabled);
        if (typeof row.banner_message === 'string') setBannerMessage(row.banner_message);
        setAdminFeedback({
          haptics: typeof row.haptics_enabled === 'boolean' ? row.haptics_enabled : undefined,
          sound: typeof row.sound_enabled === 'boolean' ? row.sound_enabled : undefined,
        });
      })
      .subscribe();

    const questionsSubscription = supabase
      .channel('public:questions_count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'questions' }, async () => {
        // Any change on questions invalidates every cached feed view.
        feedCacheRef.current.clear();
        const { count, error: countError } = await supabase.from('questions').select('*', { count: 'exact', head: true });
        if (!countError) setTotalCount(count || 0);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(settingsSubscription);
      supabase.removeChannel(questionsSubscription);
    };
  }, []);

  // In-memory cache: per filter signature, store everything we've fetched
  // (accumulated rows + total count + next page index). When the user toggles
  // back to a previously-seen filter combo, we restore instantly without a
  // server round-trip. Invalidated by the realtime questions subscription.
  const feedCacheRef = useRef(new Map<string, { rows: Question[]; count: number; nextPage: number; ts: number }>());

  const cacheKey = useCallback(() => JSON.stringify({
    g: studyGroup ?? '',
    a: isAdmin,
    i: [...selInst].sort(),
    s: [...selSub].sort(),
    t: [...selType].sort(),
    y: [...selYear].sort(),
    q: debouncedQuery.trim().toLowerCase(),
  }), [studyGroup, isAdmin, selInst, selSub, selType, selYear, debouncedQuery]);

  const loadQuestions = useCallback(async (isNewSearch = false) => {
    // Student view requires a group choice before fetching.
    if (!isAdmin && !studyGroup) return;

    const key = cacheKey();

    // Cache hit on a fresh search → restore everything we had and skip the
    // round-trip. The next infinite-scroll tick resumes from where we left.
    if (isNewSearch) {
      const cached = feedCacheRef.current.get(key);
      if (cached) {
        setQuestions(cached.rows);
        setFilteredCount(cached.count);
        setHasMore(cached.rows.length < cached.count);
        setPage(cached.nextPage);
        setLoading(false);
        return;
      }
    }

    const currentPage = isNewSearch ? 0 : page;
    const pageSize = 20;
    const offset = currentPage * pageSize;

    if (isNewSearch) { setLoading(true); setQuestions([]); }
    else { setIsFetchingMore(true); }

    const params = {
      p_group_subjects: isAdmin ? null : (studyGroup ? GROUP_SUBJECTS[studyGroup] : null),
      p_institution_order: INSTITUTION_ORDER,
      // Students default to the 3-institution allowlist (NDC/HCC/SJHSS) so
       // 'Unknown' / ad-hoc labels never leak into the student feed. Admin
       // gets the unfiltered view.
      p_inst_filter:    selInst.length > 0 ? selInst : (isAdmin ? null : INSTITUTION_ORDER),
      p_subject_filter: selSub.length  > 0 ? selSub  : null,
      p_type_filter:    selType.length > 0 ? selType.map(t => t.toLowerCase()) : null,
      p_year_filter:    selYear.length > 0 ? selYear : null,
      p_include_hidden: isAdmin,
      p_search:         debouncedQuery.trim() || null,
      p_offset: offset,
      p_limit: pageSize,
    };

    const { data, error } = await supabase.rpc('fetch_questions_feed', params);

    if (error) {
      console.error('[fetch_questions_feed] error:', error, 'params:', params);
    } else if (data) {
      const payload = data as { rows?: Question[]; count?: number };
      const rows = payload.rows ?? [];
      const count = payload.count ?? 0;
      console.debug('[fetch_questions_feed] count:', count, 'rows:', rows.length, 'params:', params);

      if (isNewSearch) {
        setQuestions(rows);
        feedCacheRef.current.set(key, { rows, count, nextPage: 1, ts: Date.now() });
      } else {
        setQuestions(prev => {
          const merged = [...prev, ...rows];
          feedCacheRef.current.set(key, { rows: merged, count, nextPage: currentPage + 1, ts: Date.now() });
          return merged;
        });
      }

      setHasMore(offset + rows.length < count);
      if (isNewSearch) setFilteredCount(count);
      if (!isNewSearch) setPage(currentPage + 1);
      else setPage(1);
    }
    setLoading(false);
    setIsFetchingMore(false);
  }, [page, selInst, selSub, selType, selYear, isAdmin, studyGroup, debouncedQuery, cacheKey]);

  // Wobble: once the first cards have actually loaded, mark the session as
  // "wobble shown" and clear the flag a moment later so subsequent renders
  // (filter changes, etc.) don't re-trigger the animation.
  useEffect(() => {
    if (!wobbleEnabled || questions.length === 0 || !student?.phone) return;
    try { sessionStorage.setItem('wobbleShown', '1'); } catch { /* ignore */ }
    const t = setTimeout(() => setWobbleEnabled(false), 1500);
    return () => clearTimeout(t);
  }, [wobbleEnabled, questions.length, student?.phone]);

  // Infinite scroll
  useEffect(() => {
    if (loading || !hasMore || isFetchingMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadQuestions();
    }, { threshold: 0.1, rootMargin: '400px' });
    const sentinel = document.getElementById('scroll-sentinel');
    if (sentinel) observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, isFetchingMore, loadQuestions, isAdmin]);

  // Re-fetch on filters / admin / group / search change. Gated on
  // filtersRestored so we don't fetch with empty filters before the saved
  // selection loads from the DB (avoids a flash of unfiltered content).
  useEffect(() => {
    if (!filtersRestored) return;
    if (isAdmin || studyGroup) loadQuestions(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selInst, selSub, selType, selYear, isAdmin, studyGroup, debouncedQuery, filtersRestored]);

  const updateQuestions = (newQuestions: Question[]) => setQuestions(newQuestions);

  const handleSettingChange = (key: keyof Settings, val: boolean) => {
    setSettings(prev => {
      const n = { ...prev, [key]: val };
      if (key === 'showExp' && val) n.showAns = true;
      if (key === 'showAns' && !val) n.showExp = false;
      return n;
    });
  };

  const handleThemeChange = (t: Theme) => setTheme(t);

  const clearAllFilters = () => {
    setSelInst([]); setSelSub([]); setSelType([]); setSelYear([]);
  };

  const pickGroup = (g: Group) => {
    setStudyGroup(g);
    setLastGroup(g);
    setSelSub([]); // previously selected subjects may not exist in the new group
    setIsChoosingGroup(false);
    const phone = student?.phone;
    if (phone) {
      supabase
        .from('student_progress')
        .upsert({ student_phone: phone, study_group: g })
        .then(({ error }) => { if (error) console.error('[saveGroup]', error); });
    }
  };

  // Subjects shown in the student-side filter modal — intersect DB subjects
  // with the group's allow-list, preserving the group's display order.
  const studentSubjectOptions = studyGroup
    ? GROUP_SUBJECTS[studyGroup].filter(s => subjectOptions.includes(s))
    : subjectOptions;

  // Institutions visible to students — intersect DB institutions with the
  // INSTITUTION_ORDER allowlist (NDC / HCC / SJHSS only). 'Unknown' and any
  // future ad-hoc labels stay in the DB but never appear in the student UI.
  const studentCollegeOptions = collegeOptions.filter(c => INSTITUTION_ORDER.includes(c));

  // Render: admin login if requested but no session yet
  if (wantsAdmin && !adminSession) {
    return <AdminLogin onCancel={cancelAdminEntry} onSuccess={(s) => setAdminSession(s)} />;
  }

  // Student must pick a group before seeing the feed
  if (!isAdmin && (!studyGroup || isChoosingGroup)) {
    return (
      <GroupSelector
        onSelect={pickGroup}
        currentGroup={lastGroup}
        onCancel={isChoosingGroup && studyGroup ? () => setIsChoosingGroup(false) : undefined}
      />
    );
  }

  return (
    <div className={isAdmin ? "" : "app-container"}>
      {isAdmin && adminSession ? (
        <AdminDashboard
          questions={questions}
          onUpdate={updateQuestions}
          onExit={handleSignOut}
          session={adminSession}
          collegeOptions={collegeOptions}
          subjectOptions={subjectOptions}
          typeOptions={typeOptions}
          yearOptions={yearOptions}
          selInst={selInst} setSelInst={setSelInst}
          selSub={selSub} setSelSub={setSelSub}
          selType={selType} setSelType={setSelType}
          selYear={selYear} setSelYear={setSelYear}
          onClear={clearAllFilters}
          hasMore={hasMore}
          isLoadingMore={isFetchingMore}
          totalCount={totalCount}
          filteredCount={filteredCount}
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          highlightQuery={debouncedQuery}
        />
      ) : (
        <>
          {bannerEnabled && bannerMessage && (
            <div className={`announce-banner ${announceVisible ? '' : 'announce-hidden'}`} role="status">
              <span>{bannerMessage}</span>
            </div>
          )}
          <div className="sticky-top">
            <header>
              <h2>{student?.name ? `Hi, ${firstName(student.name)}!` : 'Admission Prep'}</h2>
              {searchOpen && (
                <div className="search-bar search-bar-inline">
                  <I.Search size={16} />
                  <input
                    type="text"
                    placeholder="Search…"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    autoFocus
                  />
                  {searchQuery && (
                    <button className="search-clear" onClick={() => setSearchQuery('')} aria-label="Clear search">
                      <I.Close size={14} />
                    </button>
                  )}
                </div>
              )}
              <div className="header-actions">
                <button
                  className={`menu-btn ${searchOpen ? 'active' : ''}`}
                  onClick={() => {
                    if (searchOpen) { setSearchQuery(''); setDebouncedQuery(''); }
                    setSearchOpen(o => !o);
                  }}
                  aria-label={searchOpen ? 'Close search' : 'Search'}
                >
                  {searchOpen ? <I.Close /> : <I.Search />}
                </button>
                <button className="menu-btn" onClick={() => setIsSidebarOpen(true)} aria-label="Open settings">
                  <I.Gear />
                </button>
              </div>
            </header>
            <FilterBar
              collegeOptions={studentCollegeOptions}
              subjectOptions={studentSubjectOptions}
              typeOptions={typeOptions}
              yearOptions={yearOptions}
              selInst={selInst} setSelInst={setSelInst}
              selSub={selSub} setSelSub={setSelSub}
              selType={selType} setSelType={setSelType}
              selYear={selYear} setSelYear={setSelYear}
              onClear={clearAllFilters}
            />
          </div>
          <main className="content-feed" ref={feedRef}>
            {loading ? (
              <>
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
              </>
            ) : questions.length > 0 ? (
              <>
                {questions.map((q, idx) => (
                  <QuestionCard
                    key={`${q.id}-${idx}`}
                    question={q}
                    settings={settings}
                    isRead={readSet.has(q.id)}
                    wobble={wobbleEnabled && idx === 0}
                    searchQuery={debouncedQuery}
                    isFlagged={flaggedSet.has(q.id)}
                    onToggleFlag={student?.phone ? () => toggleFlag(q.id) : undefined}
                  />
                ))}
                <div id="scroll-sentinel" style={{ height: '20px', margin: '10px 0' }} />
                <div className="feed-end">
                  {isFetchingMore ? 'Loading more…' : (hasMore ? 'Scroll for more' : `${filteredCount} question${filteredCount === 1 ? '' : 's'} · end of feed`)}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <I.Inbox />
                <div className="empty-state-title">No questions match your filters</div>
                <div className="empty-state-msg">Try removing a filter or clearing them all.</div>
                <button onClick={clearAllFilters}>Clear filters</button>
              </div>
            )}
          </main>
          <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} settings={settings} onSettingChange={handleSettingChange} theme={theme} onThemeChange={handleThemeChange} group={studyGroup} onChangeGroup={() => { setIsSidebarOpen(false); setIsChoosingGroup(true); }} userHaptics={userHaptics} userSound={userSound} onFeedbackChange={handleFeedbackChange} />
        </>
      )}
    </div>
  );
}

/* ============ Filter Bar ============ */
function FilterBar({ collegeOptions, subjectOptions, typeOptions, yearOptions, selInst, setSelInst, selSub, setSelSub, selType, setSelType, selYear, setSelYear, onClear }: { collegeOptions: string[]; subjectOptions: string[]; typeOptions: string[]; yearOptions: string[]; selInst: string[]; setSelInst: React.Dispatch<React.SetStateAction<string[]>>; selSub: string[]; setSelSub: React.Dispatch<React.SetStateAction<string[]>>; selType: string[]; setSelType: React.Dispatch<React.SetStateAction<string[]>>; selYear: string[]; setSelYear: React.Dispatch<React.SetStateAction<string[]>>; onClear: () => void }) {
  const [modal, setModal] = useState<string | null>(null);

  const toggle = (setter: React.Dispatch<React.SetStateAction<string[]>>, val: string) => {
    setter((prev: string[]) => prev.includes(val) ? prev.filter(i => i !== val) : [...prev, val]);
  };

  const label = (l: string, s: string[], format?: (v: string) => string) => {
    const fmt = format ?? ((v: string) => v);
    return s.length === 0 ? l : (s.length === 1 ? fmt(s[0]) : `${fmt(s[0])} +${s.length - 1}`);
  };

  const hasAnyFilter = selInst.length > 0 || selSub.length > 0 || selType.length > 0 || selYear.length > 0;

  return (
    <div className="filter-row" style={{ gridTemplateColumns: hasAnyFilter ? 'repeat(4, 1fr) 40px' : 'repeat(4, 1fr)' }}>
      <button className={`filter-btn ${selInst.length ? 'active' : ''}`} onClick={() => setModal('Inst')}><span>{label('কলেজ', selInst, displayInstitution)}</span><I.Chevron /></button>
      <button className={`filter-btn ${selSub.length ? 'active' : ''}`} onClick={() => setModal('Subj')}><span>{label('বিষয়', selSub, displaySubject)}</span><I.Chevron /></button>
      <button className={`filter-btn ${selType.length ? 'active' : ''}`} onClick={() => setModal('Type')}><span>{label('ধরণ', selType)}</span><I.Chevron /></button>
      <button className={`filter-btn ${selYear.length ? 'active' : ''}`} onClick={() => setModal('Year')}><span>{label('বছর', selYear, displayYear)}</span><I.Chevron /></button>
      {hasAnyFilter && <button className="filter-btn filter-clear" onClick={onClear} title="সব ফিল্টার মুছে দাও" aria-label="Clear all filters"><I.Close /></button>}

      {modal === 'Inst' && <MultiSelectModal title="কলেজ" options={collegeOptions} selected={selInst} onToggle={(v: string) => toggle(setSelInst, v)} onSelectAll={() => setSelInst(collegeOptions)} onClear={() => setSelInst([])} onClose={() => setModal(null)} getDisplay={displayInstitution} />}
      {modal === 'Subj' && <MultiSelectModal title="বিষয়" options={subjectOptions} selected={selSub} onToggle={(v: string) => toggle(setSelSub, v)} onSelectAll={() => setSelSub(subjectOptions)} onClear={() => setSelSub([])} onClose={() => setModal(null)} getDisplay={displaySubject} />}
      {modal === 'Type' && <MultiSelectModal title="ধরণ" options={typeOptions} selected={selType} onToggle={(v: string) => toggle(setSelType, v)} onSelectAll={() => setSelType(typeOptions)} onClear={() => setSelType([])} onClose={() => setModal(null)} />}
      {modal === 'Year' && <MultiSelectModal title="বছর" options={yearOptions} selected={selYear} onToggle={(v: string) => toggle(setSelYear, v)} onSelectAll={() => setSelYear(yearOptions)} onClear={() => setSelYear([])} onClose={() => setModal(null)} getDisplay={displayYear} />}
    </div>
  );
}

/* ============ Question Card ============ */
function QuestionCard({ question, isAdmin = false, onUpdateField, settings, isRead = false, wobble = false, searchQuery = '', isFlagged = false, onToggleFlag }: { question: Question; isAdmin?: boolean; onUpdateField?: (f: keyof Question, v: any) => void; settings?: Settings; isRead?: boolean; wobble?: boolean; searchQuery?: string; isFlagged?: boolean; onToggleFlag?: () => void }) {
  const [sel, setSel] = useState<number | null>(null);
  const [sol, setSol] = useState(false);
  const [optRevealed, setOptRevealed] = useState(true);
  const [ansRevealed, setAnsRevealed] = useState(false);
  // Swipe-to-toggle-read is wired at the App level via native addEventListener
  // on the feed root (delegation by data-question-id). React's synthetic
  // touch handlers were unreliable in some Android WebViews / real phones.

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

  useEffect(() => { setSel(null); }, [question.id]);

  const handleOptionClick = (idx: number) => {
    if (isAdmin) return;
    if (sel === null || !ansRevealed) {
      setSel(idx);
      setAnsRevealed(true);
      if (settings?.autoExp) setSol(true);
      feedback(idx === question.answer_index ? 'success' : 'error');
    }
  };

  // Some SQ rows were imported with the question duplicated into BOTH the
  // stimulus and the single part — which renders the same text twice. When
  // the stimulus exactly equals the lone part's question, treat the stimulus
  // as redundant: hide the header and the (now pointless) part label.
  const sqParts = question.parts || [];
  const stimulusIsDupOfPart =
    question.type === 'sq' &&
    sqParts.length === 1 &&
    !!question.stimulus &&
    question.stimulus.trim() === (sqParts[0]?.question || '').trim();

  const headerText = question.type === 'mcq' ? (question.question || "") : (question.stimulus || "");
  const showHeader = !!headerText.trim() && !stimulusIsDupOfPart;
  const showLabel = !stimulusIsDupOfPart && (!!question.stimulus || sqParts.length > 1);
  const subjectColor = SUBJECT_COLORS[question.subject] || 'var(--text-faint)';
  const shouldDim = question.hidden || isRead;

  // Report/flag button — shown in the Explanation/Solution title row once the
  // student has revealed it. Student-side only.
  const flagBtn = (!isAdmin && onToggleFlag) ? (
    <button
      className={`flag-btn ${isFlagged ? 'flagged' : ''}`}
      onClick={onToggleFlag}
      title={isFlagged ? 'রিপোর্ট করা হয়েছে — বাতিল করতে চাপুন' : 'এই প্রশ্ন বা ব্যাখ্যায় ভুল থাকলে রিপোর্ট করুন'}
      aria-label="Report a mistake"
    >
      <I.Flag filled={isFlagged} />
      <span>{isFlagged ? 'Flagged' : 'Raise flag'}</span>
    </button>
  ) : null;

  return (
    <article
      className={`card ${shouldDim ? 'read' : ''} ${wobble ? 'wobble' : ''}`}
      data-question-id={isAdmin ? undefined : question.id}
    >
      <div className="card-meta">
        <span className="badge badge-subject" style={{ background: subjectColor }}>{displaySubject(question.subject)}</span>
        <span className="badge-meta">{displayInstitution(question.institution)} · {displayYear(question.year)}</span>
        <div className="card-meta-end">
          {question.serial && <span className="badge-serial">#{question.serial}</span>}
        </div>
      </div>
      {showHeader && (
        <EditableText className="card-header-main" text={headerText} isEditable={isAdmin} highlight={searchQuery} onSave={(v: string) => onUpdateField?.(question.type === 'mcq' ? 'question' : 'stimulus', v)} />
      )}
      {question.type === 'mcq' ? (
        <>
          {(optRevealed || isAdmin) && (
            <div className="section">
              {question.options?.map((opt: string, i: number) => {
                let cl = 'option';
                if (ansRevealed || isAdmin) {
                  if (i === question.answer_index) cl += ' correct-reveal';
                  else if (i === sel) cl += ' wrong-reveal';
                }
                const isInteractionDisabled = ansRevealed && !isAdmin;
                const showCheck = (ansRevealed || isAdmin) && i === question.answer_index;
                const showCross = (ansRevealed || isAdmin) && i === sel && sel !== question.answer_index;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {isAdmin && (
                      <input
                        type="radio"
                        name={`q-${question.id}-ans`}
                        checked={question.answer_index === i}
                        onChange={() => onUpdateField?.('answer_index', i)}
                        title="Set as correct answer"
                        style={{ cursor: 'pointer', width: '18px', height: '18px', accentColor: 'var(--primary)' }}
                      />
                    )}
                    <button className={cl} onClick={() => handleOptionClick(i)} disabled={isInteractionDisabled} style={{ flex: 1 }}>
                      <strong>{String.fromCharCode(65 + i)}</strong>
                      <EditableText text={opt} isEditable={isAdmin} highlight={searchQuery} onSave={(v: string) => { const o = [...(question.options || [])]; o[i] = v; onUpdateField?.('options', o); }} />
                      {showCheck && <span className="option-icon"><I.Check /></span>}
                      {showCross && <span className="option-icon"><I.X /></span>}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {(ansRevealed && !optRevealed && !isAdmin) && (
            <div className="section">
              <div className="section-title">Correct Answer</div>
              <div className="answer-box">
                <strong>{String.fromCharCode(65 + (question.answer_index || 0))}</strong>
                <EditableText text={question.options?.[question.answer_index || 0] || ""} isEditable={false} highlight={searchQuery} onSave={() => {}} />
              </div>
            </div>
          )}
          {(sol || isAdmin) && question.explanation && (
            <div className="section">
              <div className="section-title-row">
                <span className="section-title">Explanation</span>
                {flagBtn}
              </div>
              <EditableText text={question.explanation} isEditable={isAdmin} highlight={searchQuery} style={{ fontSize: '0.94rem', color: 'var(--text)', lineHeight: 1.6 }} onSave={(v: string) => onUpdateField?.('explanation', v)} />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="section">
            {(question.parts || []).map((p: { label: string; question: string; mark: number }, i: number) => (
              <div key={i} className="cq-part">
                {showLabel && <strong>{p.label || "?"})</strong>}
                <EditableText text={p.question || ""} isEditable={isAdmin} highlight={searchQuery} style={{ display: 'inline' }} onSave={(v: string) => { const pts = [...(question.parts || [])]; pts[i] = { ...pts[i], question: v }; onUpdateField?.('parts', pts); }} />
                <span className="cq-mark">[{p.mark || 0}]</span>
              </div>
            ))}
            {isAdmin && (!question.parts || question.parts.length === 0) && !question.stimulus && <p style={{ color: 'var(--wrong)', fontSize: '0.8rem' }}>⚠️ Missing parts and stimulus</p>}
          </div>
          {(sol || isAdmin) && (
            <div className="section">
              <div className="section-title-row">
                <span className="section-title">Solution</span>
                {flagBtn}
              </div>
              <EditableText text={question.solution || ""} isEditable={isAdmin} highlight={searchQuery} style={{ fontSize: '0.94rem', color: 'var(--text)', lineHeight: 1.6 }} onSave={(v: string) => onUpdateField?.('solution', v)} />
            </div>
          )}
        </>
      )}
      {!isAdmin && (
        question.type === 'mcq' ? (
          <div className="card-footer">
            <button className={`toggle-btn ${optRevealed ? 'active' : ''}`} onClick={() => { feedback('press'); setOptRevealed(!optRevealed); }}>
              <I.List /> Options
            </button>
            <button className={`toggle-btn ${ansRevealed ? 'active' : ''}`} onClick={() => {
              feedback('press');
              const newVal = !ansRevealed;
              setAnsRevealed(newVal);
              if (!newVal) setSol(false);
            }}>
              <I.Target /> Answer
            </button>
            <button className={`toggle-btn ${sol ? 'active' : ''}`} onClick={() => {
              feedback('press');
              const newVal = !sol;
              setSol(newVal);
              if (newVal) setAnsRevealed(true);
            }}>
              <I.Bulb /> Explain
            </button>
          </div>
        ) : (
          <div className={`sq-footer ${sol ? 'active' : ''}`} onClick={() => { feedback('press'); setSol(!sol); }}>
            <I.Bulb /> {sol ? 'Hide Solution' : 'View Solution'}
          </div>
        )
      )}
    </article>
  );
}

/* ============ Admin Dashboard (writes route through Edge Function) ============ */
function AdminDashboard({
  questions,
  onUpdate,
  onExit,
  session,
  collegeOptions,
  subjectOptions,
  typeOptions,
  yearOptions,
  selInst, setSelInst,
  selSub, setSelSub,
  selType, setSelType,
  selYear, setSelYear,
  onClear,
  hasMore,
  isLoadingMore,
  totalCount,
  filteredCount,
  searchValue,
  onSearchChange,
  highlightQuery
}: {
  questions: Question[];
  onUpdate: (qs: Question[]) => void;
  onExit: () => void;
  session: AdminSession;
  collegeOptions: string[];
  subjectOptions: string[];
  typeOptions: string[];
  yearOptions: string[];
  selInst: string[]; setSelInst: React.Dispatch<React.SetStateAction<string[]>>;
  selSub: string[]; setSelSub: React.Dispatch<React.SetStateAction<string[]>>;
  selType: string[]; setSelType: React.Dispatch<React.SetStateAction<string[]>>;
  selYear: string[]; setSelYear: React.Dispatch<React.SetStateAction<string[]>>;
  onClear: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  totalCount: number;
  filteredCount: number;
  searchValue: string;
  onSearchChange: (v: string) => void;
  highlightQuery: string;
}) {
  // Wrap callAdmin so that an invalid-credentials response auto-signs-out.
  const adminCall = useCallback(async <T = unknown>(op: string, payload: unknown): Promise<AdminResult<T>> => {
    const r = await callAdmin<T>(op, payload, session);
    if (r.error === 'Invalid credentials') {
      alert('Your admin session is no longer valid. Please sign in again.');
      onExit();
    }
    return r;
  }, [session, onExit]);

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

  const [fontBn, setFontBn] = useState("'Noto Serif Bengali', serif");
  const [fontEn, setFontEn] = useState("'Times New Roman', serif");
  const [bannerEnabledLocal, setBannerEnabledLocal] = useState(false);
  const [bannerMessageLocal, setBannerMessageLocal] = useState('প্রশ্ন আপলোডের কাজ চলছে');
  const [hapticsLocal, setHapticsLocal] = useState(true);
  const [soundLocal, setSoundLocal] = useState(true);

  useEffect(() => {
    const fetchSettings = async () => {
      const { data, error: settingsError } = await supabase.from('settings').select('*').single();
      if (data && !settingsError) {
        if (data.font_bn) setFontBn(data.font_bn);
        if (data.font_en) setFontEn(data.font_en);
        if (typeof data.banner_enabled === 'boolean') setBannerEnabledLocal(data.banner_enabled);
        if (typeof data.banner_message === 'string' && data.banner_message) setBannerMessageLocal(data.banner_message);
        if (typeof data.haptics_enabled === 'boolean') setHapticsLocal(data.haptics_enabled);
        if (typeof data.sound_enabled === 'boolean') setSoundLocal(data.sound_enabled);
      }
    };
    fetchSettings();
  }, []);

  const saveSettings = async () => {
    const r = await adminCall('update_settings', { font_bn: fontBn, font_en: fontEn });
    if (r.error) alert("Error saving settings: " + r.error);
    else alert("Global settings saved!");
  };

  const saveBanner = async () => {
    const r = await adminCall('update_settings', {
      banner_enabled: bannerEnabledLocal,
      banner_message: bannerMessageLocal,
    });
    if (r.error) alert("Error saving banner: " + r.error);
    else alert("Banner saved!");
  };

  const saveFeedback = async () => {
    const r = await adminCall('update_settings', {
      haptics_enabled: hapticsLocal,
      sound_enabled: soundLocal,
    });
    if (r.error) alert("Error saving feedback settings: " + r.error);
    else alert("Feedback settings saved!");
  };

  const handleBulkUpload = async () => {
    if (!previewQuestions.length) {
      alert("Please update preview first to validate your JSON.");
      return;
    }
    const r = await adminCall<Question[]>('insert_questions', previewQuestions);
    if (r.error) {
      alert("Error saving questions: " + r.error);
      return;
    }
    alert("Questions saved to Supabase!");
    if (r.data) onUpdate(sortQuestions([...questions, ...r.data]));
    setJsonInput("");
    setPreviewQuestions([]);
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
    window.scrollTo(0, 0);
  };

  const handleToggleHidden = async (q: Question) => {
    const newHidden = !q.hidden;
    const r = await adminCall('toggle_question_hidden', { id: q.id, hidden: newHidden });
    if (r.error) alert("Error updating visibility: " + r.error);
    else onUpdate(questions.map((item: Question) => item.id === q.id ? { ...item, hidden: newHidden } : item));
  };

  return (
    <div className="admin-layout">
      <div className="admin-question-list-column">
        <div className="admin-header">
          <div>
            <h3 style={{ margin: 0 }}>Admin Portal</h3>
            <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '4px' }}>
              Total Questions in DB: <strong>{totalCount}</strong>
            </p>
          </div>
          <button className="btn btn-secondary" onClick={onExit} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.45rem 0.85rem' }}><I.LogOut /> Sign Out</button>
        </div>

        <div className="sticky-filter-section">
          <div style={{ marginBottom: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h4 style={{ margin: 0 }}>Active Filters (<strong>{filteredCount}</strong> matches found)</h4>
            {(selInst.length > 0 || selSub.length > 0 || selType.length > 0 || selYear.length > 0) && (
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
          <div className="search-bar" style={{ margin: '0.6rem 0 0' }}>
            <I.Search size={16} />
            <input
              type="text"
              placeholder="Search questions, topics…"
              value={searchValue}
              onChange={e => onSearchChange(e.target.value)}
            />
            {searchValue && (
              <button className="search-clear" onClick={() => onSearchChange('')} aria-label="Clear search">
                <I.Close size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="admin-cards-view">
          {questions.map((q: Question, idx: number) => (
            <div key={`${q.id}-${idx}`} className="admin-card-wrapper">
              <div className="admin-card-actions">
                <button
                  className={`btn ${q.hidden ? 'btn-secondary' : 'btn-primary'}`}
                  style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
                  onClick={() => handleToggleHidden(q)}
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
                searchQuery={highlightQuery}
                onUpdateField={async (f, v) => {
                  const updatedQuestion = { ...q, [f]: v };
                  const r = await adminCall('update_question', { id: q.id, fields: { [f]: v } });
                  if (r.error) alert("Error saving change: " + r.error);
                  else onUpdate(questions.map(item => item.id === q.id ? updatedQuestion : item));
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

        <div className="admin-section">
          <h4>Announcement Banner</h4>
          <p style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.25rem', marginBottom: '1rem' }}>
            Shows a single-line banner at the top of the student feed. Auto-hides when the student scrolls.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', marginBottom: '0.85rem', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={bannerEnabledLocal}
              onChange={e => setBannerEnabledLocal(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--primary)' }}
            />
            Show banner to students
          </label>
          <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '4px' }}>Banner text</label>
          <input
            type="text"
            className="edit-input"
            value={bannerMessageLocal}
            onChange={e => setBannerMessageLocal(e.target.value)}
            placeholder="প্রশ্ন আপলোডের কাজ চলছে"
            style={{ marginBottom: '1rem', width: '100%' }}
          />
          <button className="btn btn-primary" onClick={saveBanner}>Save Banner</button>
        </div>

        <div className="admin-section">
          <h4>Feedback (Haptics &amp; Sound)</h4>
          <p style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.25rem', marginBottom: '1rem' }}>
            Vibration + tap/answer sounds on the student side. Turn off globally if needed.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', marginBottom: '0.6rem', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer' }}>
            <input type="checkbox" checked={hapticsLocal} onChange={e => setHapticsLocal(e.target.checked)} style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--primary)' }} />
            Haptics (vibration)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', marginBottom: '1rem', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer' }}>
            <input type="checkbox" checked={soundLocal} onChange={e => setSoundLocal(e.target.checked)} style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--primary)' }} />
            Sound effects
          </label>
          <button className="btn btn-primary" onClick={saveFeedback}>Save Feedback Settings</button>
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
                        const { id, ...fields } = q;
                        const r = await adminCall('update_question', { id, fields });
                        if (r.error) alert("Error saving: " + r.error);
                        else {
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
