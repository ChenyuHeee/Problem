const BANKS_INDEX_URL = './banks/index.json';
const STORAGE_PREFIX = 'quizProgress_v2:';
const GITHUB_ISSUES_NEW_URL = 'https://github.com/ChenyuHeee/Problem/issues/new';

function $(id) {
  return document.getElementById(id);
}

function typeLabel(t) {
  switch (t) {
    case 'single':
      return '单选题';
    case 'multiple':
      return '多选题';
    case 'judge':
      return '判断题';
    case 'blank':
      return '填空题';
    default:
      return t;
  }
}

function normalizeAnswerText(s) {
  return String(s ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBlank(s) {
  // Keep it conservative: trim + collapse spaces; do NOT remove meaningful punctuation.
  return normalizeAnswerText(s);
}

function sortLetters(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .split('')
    .sort()
    .join('');
}

function deriveOptionsFromStem(stem) {
  const s = String(stem ?? '');

  // Find option markers like A. / A． / A、 (including cases without spaces between options)
  const markerRe = /([A-H])[\.．、]\s*/g;
  const matches = [];
  let m;
  while ((m = markerRe.exec(s)) !== null) {
    matches.push({ label: m[1], index: m.index, end: markerRe.lastIndex });
    if (matches.length > 20) break;
  }
  if (matches.length < 2) return null;

  const prefix = s.slice(0, matches[0].index).trim();
  const options = {};
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].index : s.length;
    const text = s.slice(start, end).replace(/\s+/g, ' ').trim();
    if (text) options[matches[i].label] = text;
  }

  const labels = Object.keys(options);
  if (labels.length < 2) return null;
  return { prefix, options };
}

function storageKeys(bankId) {
  const base = `${STORAGE_PREFIX}${bankId}`;
  return { primary: base, backup: `${base}__backup` };
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return '';
  }
}

function getAllSavedBankStates() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      if (key.endsWith('__backup')) continue;

      const bankId = key.slice(STORAGE_PREFIX.length);
      const st = loadState(bankId);
      if (st) out[bankId] = st;
    }
  } catch (e) {
    console.warn('Failed to enumerate localStorage for export', e);
  }
  return out;
}

function isValidState(state) {
  return !!(
    state &&
    typeof state === 'object' &&
    state.version === 1 &&
    Array.isArray(state.questionIds) &&
    state.answers &&
    typeof state.answers === 'object'
  );
}

function mergeAnswerRecord(existingRec, incomingRec) {
  if (!existingRec) return incomingRec;
  if (!incomingRec) return existingRec;

  const exWrong = existingRec.correct === false;
  const inWrong = incomingRec.correct === false;

  // Wrong union: if either side is wrong, keep it wrong.
  if (exWrong || inWrong) {
    const chosen = exWrong ? existingRec : incomingRec;
    return {
      response: chosen.response,
      correct: false,
      ts: Math.max(Number(existingRec.ts || 0), Number(incomingRec.ts || 0)) || Date.now(),
    };
  }

  // Both are correct (or missing correct flags): prefer newer timestamp.
  const exTs = Number(existingRec.ts || 0);
  const inTs = Number(incomingRec.ts || 0);
  return inTs >= exTs ? incomingRec : existingRec;
}

function mergeStates(existingState, incomingState) {
  if (!isValidState(existingState)) return incomingState;
  if (!isValidState(incomingState)) return existingState;

  // Merge questionIds (keep existing order, then append new ones)
  const mergedQuestionIds = Array.isArray(existingState.questionIds) ? [...existingState.questionIds] : [];
  const seen = new Set(mergedQuestionIds);
  for (const qid of incomingState.questionIds || []) {
    if (!seen.has(qid)) {
      mergedQuestionIds.push(qid);
      seen.add(qid);
    }
  }

  // Merge answers: union answered; if either wrong => wrong
  const mergedAnswers = { ...(existingState.answers || {}) };
  for (const [qid, inRec] of Object.entries(incomingState.answers || {})) {
    mergedAnswers[qid] = mergeAnswerRecord(mergedAnswers[qid], inRec);
  }

  return {
    version: 1,
    mode: existingState.mode || incomingState.mode || 'all',
    currentIndexAll: Number.isFinite(existingState.currentIndexAll) ? existingState.currentIndexAll : (incomingState.currentIndexAll || 0),
    currentIndexWrong: Number.isFinite(existingState.currentIndexWrong) ? existingState.currentIndexWrong : (incomingState.currentIndexWrong || 0),
    questionIds: mergedQuestionIds,
    answers: mergedAnswers,
  };
}

async function copyText(text) {
  const s = String(text ?? '');
  if (!s) return false;

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch {
      // Fallback below
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function loadState(bankId) {
  const tryParse = (raw) => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const { primary: pKey, backup: bKey } = storageKeys(bankId);

  const primary = tryParse(localStorage.getItem(pKey));
  if (primary) return primary;

  const backup = tryParse(localStorage.getItem(bKey));
  if (backup) {
    // Try to self-heal primary from backup
    try {
      localStorage.setItem(pKey, JSON.stringify(backup));
    } catch {
      // ignore
    }
  }
  return backup;
}

function saveState(bankId, state) {
  // Write primary first; then keep a backup copy for recovery.
  // This reduces risk of losing progress due to a partially written/corrupted value.
  const payload = JSON.stringify(state);
  const { primary: pKey, backup: bKey } = storageKeys(bankId);
  try {
    localStorage.setItem(pKey, payload);
  } catch (e) {
    console.warn('Failed to write primary progress to localStorage', e);
  }
  try {
    localStorage.setItem(bKey, payload);
  } catch (e) {
    console.warn('Failed to write backup progress to localStorage', e);
  }
}

function makeInitialState(questionIds) {
  return {
    version: 1,
    mode: 'all',
    currentIndexAll: 0,
    currentIndexWrong: 0,
    questionIds,
    answers: {},
  };
}

function computeStats(state) {
  const entries = Object.values(state.answers || {});
  const answered = entries.length;
  const correct = entries.filter((e) => e.correct).length;
  const wrong = entries.filter((e) => e.correct === false).length;
  return { answered, correct, wrong };
}

function buildWrongIds(state) {
  const wrong = [];
  for (const qid of state.questionIds) {
    const rec = state.answers?.[qid];
    if (rec && rec.correct === false) wrong.push(qid);
  }
  return wrong;
}

function getActiveIds(state) {
  return state.mode === 'wrong' ? buildWrongIds(state) : state.questionIds;
}

function getActiveIndex(state) {
  return state.mode === 'wrong' ? state.currentIndexWrong : state.currentIndexAll;
}

function setActiveIndex(state, idx) {
  if (state.mode === 'wrong') state.currentIndexWrong = idx;
  else state.currentIndexAll = idx;
}

function setMode(state, mode) {
  state.mode = mode;
}

function renderProgress(meta, state) {
  const { answered, correct, wrong } = computeStats(state);
  const total = state.questionIds.length;

  $('meta').textContent = meta?.source ? `题库：${meta.source}（共 ${total} 题）` : `共 ${total} 题`;

  const pct = total === 0 ? 0 : Math.round((answered / total) * 100);
  $('progressText').textContent = `进度：已答 ${answered}/${total}（正确 ${correct}，错误 ${wrong}）`;
  $('progressFill').style.width = `${pct}%`;

  const wrongCount = buildWrongIds(state).length;
  $('toggleModeBtn').textContent = state.mode === 'wrong' ? '返回练习' : `错题回顾（${wrongCount}）`;

  const banner = $('modeBanner');
  if (state.mode === 'wrong') {
    banner.hidden = false;
    banner.textContent = `错题回顾模式：共 ${wrongCount} 道错题`;
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }
}

function renderEmpty(message) {
  $('questionArea').hidden = true;
  const empty = $('emptyState');
  empty.hidden = false;
  empty.textContent = message;

  const fb = $('feedbackBtn');
  if (fb) fb.hidden = true;
}

function formatResponseForIssue(response) {
  if (Array.isArray(response)) return response.join('');
  if (response == null) return '';
  return String(response);
}

function formatOptionsForIssue(options) {
  if (!options || typeof options !== 'object') return '';
  const labels = Object.keys(options);
  labels.sort();
  return labels.map((k) => `${k}. ${String(options[k] ?? '')}`.trim()).join('\n');
}

function buildIssueUrl({ bank, meta, qid, q, state }) {
  const bankName = bank?.name || bank?.id || '';
  const title = `[题目反馈] ${bankName} - ${qid}`;

  const saved = state?.answers?.[qid] ?? null;
  const myResponse = saved ? formatResponseForIssue(saved.response) : '';

  const sourceParts = [];
  if (q?.source?.page != null) sourceParts.push(`page=${q.source.page}`);
  if (q?.source?.number != null) sourceParts.push(`no=${q.source.number}`);
  const sourceText = sourceParts.length ? sourceParts.join(', ') : '';

  const bodyLines = [
    `题库：${bankName}`,
    q?.meta?.source ? `题库来源：${q.meta.source}` : (meta?.source ? `题库来源：${meta.source}` : ''),
    `题目ID：${qid}`,
    q?.type ? `题型：${q.type}` : '',
    sourceText ? `题目位置：${sourceText}` : '',
    '',
    '【题干】',
    String(q?.stem ?? ''),
    '',
    q?.type === 'blank' ? '' : '【选项】',
    q?.type === 'blank' ? '' : formatOptionsForIssue(q?.options),
    '',
    '【正确答案】',
    String(q?.answer ?? ''),
    '',
    '【我的作答】',
    myResponse || '（未作答）',
    '',
    '【问题描述】',
    '请描述题干/选项/答案/解析哪里有误，或哪里不清楚。',
  ].filter((x) => x !== '');

  const body = bodyLines.join('\n');

  const params = new URLSearchParams();
  params.set('title', title);
  params.set('body', body);
  return `${GITHUB_ISSUES_NEW_URL}?${params.toString()}`;
}

function renderQuestion(questionsById, state, bank, meta) {
  const activeIds = getActiveIds(state);
  const idx = getActiveIndex(state);

  if (activeIds.length === 0) {
    renderEmpty(state.mode === 'wrong' ? '暂无错题。你可以先做题，答错的会自动出现在这里。' : '题库为空。');
    return;
  }

  if (idx < 0 || idx >= activeIds.length) {
    setActiveIndex(state, 0);
  }

  const qid = activeIds[getActiveIndex(state)];
  const q = questionsById[qid];
  if (!q) {
    renderEmpty('题目加载异常：找不到题目。');
    return;
  }

  const feedbackBtn = $('feedbackBtn');
  if (feedbackBtn) {
    feedbackBtn.hidden = false;
    feedbackBtn.onclick = () => {
      try {
        const url = buildIssueUrl({ bank, meta, qid, q, state });
        // Prefer same-tab navigation to avoid popup blockers in some browsers (e.g., mobile / in-app browsers).
        window.location.assign(url);
      } catch (e) {
        console.error(e);
        alert('无法打开反馈链接，请查看控制台错误。');
      }
    };
  }

  // Frontend fallback: some extracted items may have options embedded in stem.
  // Derive options on the fly so the user still has selectable answers.
  let derived = null;
  if (q.type !== 'blank' && (!q.options || Object.keys(q.options).length === 0)) {
    derived = deriveOptionsFromStem(q.stem);
  }
  const displayStem = derived ? (derived.prefix || q.stem) : q.stem;
  const displayOptions = derived ? derived.options : q.options;

  $('emptyState').hidden = true;
  $('questionArea').hidden = false;

  $('qIndex').textContent = state.mode === 'wrong'
    ? `错题 ${getActiveIndex(state) + 1}/${activeIds.length}`
    : `第 ${getActiveIndex(state) + 1}/${activeIds.length} 题`;
  $('qType').textContent = typeLabel(q.type);
  $('qStem').textContent = displayStem;

  const optionsEl = $('options');
  optionsEl.innerHTML = '';
  const blankWrap = $('blankInput');
  blankWrap.hidden = q.type !== 'blank';
  $('blankText').value = '';

  const saved = state.answers?.[qid] ?? null;

  const submitBtn = $('submitBtn');
  submitBtn.hidden = true;
  submitBtn.disabled = true;

  if (q.type !== 'blank') {
    const isMulti = q.type === 'multiple';
    const inputType = isMulti ? 'checkbox' : 'radio';
    const name = `q_${qid}`;

    // Only show Submit for multiple-choice questions.
    const showSubmit = q.type === 'multiple' && !saved;
    submitBtn.hidden = !showSubmit;
    const labels = Object.keys(displayOptions || {});
    labels.sort();

    for (const label of labels) {
      const option = document.createElement('label');
      option.className = 'option';

      const input = document.createElement('input');
      input.type = inputType;
      input.name = name;
      input.value = label;

      const l = document.createElement('div');
      l.className = 'label';
      l.textContent = `${label}.`;

      const t = document.createElement('div');
      t.className = 'text';
      t.textContent = displayOptions[label];

      option.appendChild(input);
      option.appendChild(l);
      option.appendChild(t);
      optionsEl.appendChild(option);
    }

    if (saved) {
      const resp = saved.response;
      const selected = Array.isArray(resp) ? resp : [resp];
      for (const input of optionsEl.querySelectorAll('input')) {
        if (selected.includes(input.value)) input.checked = true;
      }
    }
    // If still no options, show an empty-state hint for this question.
    if (labels.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty';
      hint.textContent = '该题未解析到可选项（可能是 PDF 排版导致）。可以先点“下一题”，或告诉我题号我再增强解析规则。';
      optionsEl.appendChild(hint);
    }

    if (q.type === 'multiple' && !saved) {
      const selectedCount = optionsEl.querySelectorAll('input:checked').length;
      submitBtn.disabled = selectedCount === 0;
    }
  } else {
    if (saved) $('blankText').value = saved.response || '';
  }
  const nextBtn = $('nextBtn');
  const resultEl = $('result');

  resultEl.hidden = true;
  resultEl.className = 'result';
  resultEl.textContent = '';

  if (saved) {
    nextBtn.disabled = false;
    lockInputs(true);
    showResult(q, saved, resultEl);
  } else {
    nextBtn.disabled = true;
    lockInputs(false);
  }
}

function lockInputs(locked) {
  for (const el of document.querySelectorAll('#answerForm input')) {
    el.disabled = locked;
  }
}

function showResult(q, saved, resultEl) {
  const ok = saved.correct === true;
  resultEl.hidden = false;
  resultEl.classList.add(ok ? 'good' : 'bad');

  const parts = [];
  parts.push(ok ? '结果：回答正确' : '结果：回答错误');

  if (q.type === 'multiple') {
    parts.push(`正确答案：${sortLetters(q.answer) || '（未知）'}`);
  } else {
    parts.push(`正确答案：${normalizeAnswerText(q.answer) || '（未知）'}`);
  }

  if (q.explanation) {
    parts.push(`答案解释：${q.explanation}`);
  }
  if (q.difficulty) {
    parts.push(`难易度：${q.difficulty}`);
  }

  resultEl.textContent = parts.join('\n');
}

function collectResponse(q) {
  if (q.type === 'blank') {
    return $('blankText').value;
  }

  const selected = Array.from(document.querySelectorAll('#options input:checked')).map((i) => i.value);

  if (q.type === 'multiple') {
    return selected;
  }

  return selected[0] || '';
}

function grade(q, response) {
  if (!q.answer) return false;

  if (q.type === 'multiple') {
    const r = Array.isArray(response) ? response.join('') : String(response ?? '');
    return sortLetters(r) === sortLetters(q.answer);
  }

  if (q.type === 'blank') {
    return normalizeBlank(response) === normalizeBlank(q.answer);
  }

  return String(response ?? '').trim().toUpperCase() === String(q.answer ?? '').trim().toUpperCase();
}

function scrollResultIntoView() {
  setTimeout(() => {
    const el = $('result');
    if (el && !el.hidden) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 0);
}

async function main() {
  const homeView = $('homeView');
  const quizView = $('quizView');
  const banksList = $('banksList');
  const homeEmpty = $('homeEmpty');

  const exportProgressBtn = $('exportProgressBtn');
  const importProgressBtn = $('importProgressBtn');
  const exportText = $('exportText');
  const importText = $('importText');
  const transferMsg = $('transferMsg');

  const backHomeBtn = $('backHomeBtn');
  const toggleModeBtn = $('toggleModeBtn');
  const resetBtn = $('resetBtn');

  function showHome() {
    homeView.hidden = false;
    quizView.hidden = true;
    backHomeBtn.hidden = true;
    toggleModeBtn.hidden = true;
    resetBtn.hidden = true;
    $('meta').textContent = '';
  }

  function showQuiz() {
    homeView.hidden = true;
    quizView.hidden = false;
    backHomeBtn.hidden = false;
    toggleModeBtn.hidden = false;
    resetBtn.hidden = false;
  }

  function parseHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    const params = new URLSearchParams(raw);
    const bank = params.get('bank');
    return { bankId: bank };
  }

  async function fetchBanksIndex() {
    const res = await fetch(BANKS_INDEX_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load banks index');
    return await res.json();
  }

  function ensureStateFor(bankId, questionIds) {
    let state = loadState(bankId);
    if (!state || state.version !== 1 || !Array.isArray(state.questionIds)) {
      state = makeInitialState(questionIds);
      saveState(bankId, state);
      return state;
    }

    // If question set changed, keep existing answers where possible
    const prev = new Set(state.questionIds);
    const next = new Set(questionIds);
    const changed = prev.size !== next.size || [...prev].some((x) => !next.has(x));
    if (changed) {
      const nextAnswers = {};
      for (const qid of questionIds) {
        if (state.answers?.[qid]) nextAnswers[qid] = state.answers[qid];
      }
      state.questionIds = questionIds;
      state.answers = nextAnswers;
      state.currentIndexAll = 0;
      state.currentIndexWrong = 0;
      state.mode = 'all';
      saveState(bankId, state);
    }

    return state;
  }

  function renderHomeList(banks) {
    banksList.innerHTML = '';
    if (!banks || banks.length === 0) {
      homeEmpty.hidden = false;
      homeEmpty.textContent = '没有找到题库文件。请把题库 PDF 放进 bank/ 并运行构建脚本生成 web/banks/index.json。';
      return;
    }
    homeEmpty.hidden = true;

    for (const b of banks) {
      const state = loadState(b.id) || makeInitialState([]);
      const total = Number(b.count || state.questionIds?.length || 0);
      const stats = computeStats(state);
      const pct = total ? Math.round((stats.answered / total) * 100) : 0;

      const row = document.createElement('div');
      row.className = 'bank';

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'bank-name';
      name.textContent = b.name;

      const meta = document.createElement('div');
      meta.className = 'bank-meta';
      meta.textContent = `进度：${stats.answered}/${total}（正确 ${stats.correct}，错误 ${stats.wrong}）`;

      const prog = document.createElement('div');
      prog.className = 'bank-progress';
      const bar = document.createElement('div');
      bar.className = 'bank-bar';
      const fill = document.createElement('div');
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      prog.appendChild(bar);

      left.appendChild(name);
      left.appendChild(meta);
      left.appendChild(prog);

      const right = document.createElement('div');
      right.className = 'bank-actions';

      const safeName = String(b.name || b.id || 'questions')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .slice(0, 80);

      const dl = document.createElement('a');
      dl.className = 'btn btn-secondary';
      if (b.sourcePdfPath) {
        dl.href = `./${b.sourcePdfPath}`;
        dl.download = `${safeName}.pdf`;
        dl.textContent = '下载原题库';
      } else {
        dl.href = `./${b.questionsPath}`;
        dl.download = `${safeName}.questions.json`;
        dl.textContent = '下载题库';
      }

      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.type = 'button';
      btn.textContent = stats.answered > 0 ? '继续' : '开始';
      btn.addEventListener('click', () => {
        location.hash = `bank=${encodeURIComponent(b.id)}`;
      });

      right.appendChild(dl);
      right.appendChild(btn);

      row.appendChild(left);
      row.appendChild(right);
      banksList.appendChild(row);
    }
  }

  let banksIndex = null;
  try {
    banksIndex = await fetchBanksIndex();
  } catch (e) {
    console.error(e);
    showHome();
    homeEmpty.hidden = false;
    homeEmpty.textContent = '无法加载题库索引（web/banks/index.json）。请先生成并提交到 GitHub Pages。';
    return;
  }

  const banks = banksIndex.banks || [];

  function setTransferMsg(msg) {
    if (!transferMsg) return;
    transferMsg.textContent = msg || '';
  }

  function buildExportPayload() {
    const statesByBankId = getAllSavedBankStates();

    const namesById = {};
    for (const b of banks) namesById[b.id] = b.name;

    const payload = {
      schema: 'quiz-progress-export',
      schemaVersion: 1,
      exportedAt: Date.now(),
      storagePrefix: STORAGE_PREFIX,
      banks: {},
    };

    for (const [bankId, st] of Object.entries(statesByBankId)) {
      if (!isValidState(st)) continue;
      payload.banks[bankId] = {
        name: namesById[bankId] || '',
        state: st,
      };
    }
    return payload;
  }

  function parseImportPayload(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch {
      return null;
    }

    // v1 canonical format
    if (parsed && parsed.schema === 'quiz-progress-export' && parsed.schemaVersion === 1 && parsed.banks) {
      return parsed;
    }

    // Compatibility: allow plain map { [bankId]: state }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const banksMap = {};
      for (const [bankId, maybeState] of Object.entries(parsed)) {
        if (isValidState(maybeState)) {
          banksMap[bankId] = { name: '', state: maybeState };
        }
      }
      if (Object.keys(banksMap).length > 0) {
        return {
          schema: 'quiz-progress-export',
          schemaVersion: 1,
          exportedAt: 0,
          storagePrefix: STORAGE_PREFIX,
          banks: banksMap,
        };
      }
    }

    return null;
  }

  function importProgressFromPayload(payload) {
    const banksMap = payload?.banks && typeof payload.banks === 'object' ? payload.banks : null;
    if (!banksMap) return { imported: 0, skipped: 0 };

    let imported = 0;
    let skipped = 0;

    for (const [bankId, entry] of Object.entries(banksMap)) {
      const st = entry && typeof entry === 'object' ? entry.state : null;
      if (!isValidState(st)) {
        skipped++;
        continue;
      }

      try {
        const existing = loadState(bankId);
        const merged = mergeStates(existing, st);
        saveState(bankId, merged);
        imported++;
      } catch (e) {
        console.warn('Failed to import progress for bank', bankId, e);
        skipped++;
      }
    }

    return { imported, skipped };
  }

  if (exportProgressBtn && exportText) {
    exportProgressBtn.addEventListener('click', async () => {
      setTransferMsg('');
      const payload = buildExportPayload();
      const text = safeJsonStringify(payload);
      exportText.value = text;
      const ok = await copyText(text);
      setTransferMsg(ok ? '已复制到剪贴板。' : '已生成文本，请手动复制。');
    });
  }

  if (importProgressBtn && importText) {
    importProgressBtn.addEventListener('click', () => {
      setTransferMsg('');
      const payload = parseImportPayload(importText.value);
      if (!payload) {
        setTransferMsg('导入失败：文本格式不正确。');
        return;
      }
      const { imported, skipped } = importProgressFromPayload(payload);
      renderHomeList(banks);
      setTransferMsg(`已导入 ${imported} 个题库进度（跳过 ${skipped} 个）。`);
    });
  }

  // Quiz runtime vars (for current bank)
  let currentBank = null;
  let meta = {};
  let questionsById = {};
  let questionIds = [];
  let state = null;

  function rerenderQuiz() {
    renderProgress(meta, state);
    renderQuestion(questionsById, state, currentBank, meta);
  }

  function getCurrentQA() {
    const activeIds = getActiveIds(state);
    if (activeIds.length === 0) return null;
    const qid = activeIds[getActiveIndex(state)];
    const q = questionsById[qid];
    if (!q) return null;
    return { qid, q };
  }

  function submitCurrentAnswer() {
    const qa = getCurrentQA();
    if (!qa) return;
    const { qid, q } = qa;
    if (state.answers?.[qid]) return;

    const response = collectResponse(q);
    // Guard: require at least some input
    if (q.type === 'blank') {
      if (!String(response ?? '').trim()) return;
    } else if (q.type === 'multiple') {
      if (!Array.isArray(response) || response.length === 0) return;
    } else {
      if (!String(response ?? '').trim()) return;
    }

    const correct = grade(q, response);
    state.answers[qid] = { response, correct, ts: Date.now() };
    saveState(currentBank.id, state);
    rerenderQuiz();
    scrollResultIntoView();
  }

  // We keep the form element for semantics, but submission is triggered by option clicks / Enter.
  $('answerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitCurrentAnswer();
  });

  // Auto-submit on option selection
  document.addEventListener('change', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.closest('#options') == null) return;

    const qa = getCurrentQA();
    if (!qa) return;
    const { qid, q } = qa;
    if (state.answers?.[qid]) return;

    if (q.type === 'multiple') {
      // Multiple-choice: user selects multiple, then explicitly taps Submit.
      const submitBtn = $('submitBtn');
      if (submitBtn) {
        const selectedCount = document.querySelectorAll('#options input:checked').length;
        submitBtn.disabled = selectedCount === 0;
      }
    } else {
      submitCurrentAnswer();
    }
  });

  // Blank: submit on Enter
  $('blankText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCurrentAnswer();
    }
  });

  $('nextBtn').addEventListener('click', () => {
    const activeIds = getActiveIds(state);
    if (activeIds.length === 0) return;

    const idx = getActiveIndex(state);
    if (idx + 1 < activeIds.length) {
      setActiveIndex(state, idx + 1);
      saveState(currentBank.id, state);
      rerenderQuiz();

      // Mobile UX: reset scroll to top for the next question.
      setTimeout(() => {
        const top = document.querySelector('.container');
        if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 0);
      return;
    }

    // Completed current mode
    if (state.mode === 'wrong') {
      renderEmpty('错题已回顾完成。点击“返回练习”继续。');
      return;
    }

    const wrongCount = buildWrongIds(state).length;
    if (wrongCount > 0) {
      renderEmpty(`本轮练习已完成（共 ${state.questionIds.length} 题）。你有 ${wrongCount} 道错题，可点击“错题回顾”复盘。`);
    } else {
      renderEmpty(`本轮练习已完成（共 ${state.questionIds.length} 题）。全部正确，做得不错。`);
    }
  });

  $('toggleModeBtn').addEventListener('click', () => {
    if (state.mode === 'wrong') {
      setMode(state, 'all');
    } else {
      setMode(state, 'wrong');
      state.currentIndexWrong = 0;
    }
    saveState(currentBank.id, state);
    rerenderQuiz();
  });

  $('resetBtn').addEventListener('click', () => {
    const ok = confirm('确定要清空全部答题记录吗？');
    if (!ok) return;
    state = makeInitialState(questionIds);
    saveState(currentBank.id, state);
    rerenderQuiz();
  });

  backHomeBtn.addEventListener('click', () => {
    location.hash = '';
  });

  async function enterBank(bankId) {
    const bank = banks.find((b) => b.id === bankId);
    if (!bank) {
      showHome();
      renderHomeList(banks);
      return;
    }

    showQuiz();
    currentBank = bank;
    $('meta').textContent = `题库：${bank.name}`;

    const res = await fetch(`./${bank.questionsPath}`, { cache: 'no-store' });
    if (!res.ok) {
      renderEmpty('无法加载该题库的 questions.json。');
      return;
    }

    const data = await res.json();
    meta = data.meta || {};
    const questions = data.questions || [];

    questionsById = {};
    questionIds = [];
    for (const q of questions) {
      const id = String(q.id);
      questionsById[id] = q;
      questionIds.push(id);
    }

    state = ensureStateFor(bank.id, questionIds);
    rerenderQuiz();
  }

  function handleRoute() {
    const { bankId } = parseHash();
    if (!bankId) {
      showHome();
      renderHomeList(banks);
      return;
    }
    enterBank(bankId).catch((e) => {
      console.error(e);
      showHome();
      renderHomeList(banks);
    });
  }

  window.addEventListener('hashchange', () => {
    handleRoute();
  });

  handleRoute();
}

main().catch((err) => {
  console.error(err);
  renderEmpty('加载失败：请查看控制台错误。');
});
