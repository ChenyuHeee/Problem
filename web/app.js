const QUESTIONS_URL = './questions.json';
const STORAGE_KEY = 'quizProgress_v1';
const STORAGE_BACKUP_KEY = 'quizProgress_v1__backup';

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

function loadState() {
  const tryParse = (raw) => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const primary = tryParse(localStorage.getItem(STORAGE_KEY));
  if (primary) return primary;

  const backup = tryParse(localStorage.getItem(STORAGE_BACKUP_KEY));
  if (backup) {
    // Try to self-heal primary from backup
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(backup));
    } catch {
      // ignore
    }
  }
  return backup;
}

function saveState(state) {
  // Write primary first; then keep a backup copy for recovery.
  // This reduces risk of losing progress due to a partially written/corrupted value.
  const payload = JSON.stringify(state);
  try {
    localStorage.setItem(STORAGE_KEY, payload);
  } catch (e) {
    console.warn('Failed to write primary progress to localStorage', e);
  }
  try {
    localStorage.setItem(STORAGE_BACKUP_KEY, payload);
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
}

function renderQuestion(questionsById, state) {
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

  if (q.type !== 'blank') {
    const isMulti = q.type === 'multiple';
    const inputType = isMulti ? 'checkbox' : 'radio';
    const name = `q_${qid}`;

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
  } else {
    if (saved) $('blankText').value = saved.response || '';
  }

  const submitBtn = $('submitBtn');
  const nextBtn = $('nextBtn');
  const resultEl = $('result');

  resultEl.hidden = true;
  resultEl.className = 'result';
  resultEl.textContent = '';

  if (saved) {
    submitBtn.disabled = true;
    nextBtn.disabled = false;
    lockInputs(true);
    showResult(q, saved, resultEl);
  } else {
    submitBtn.disabled = false;
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

async function main() {
  const res = await fetch(QUESTIONS_URL, { cache: 'no-store' });
  if (!res.ok) {
    renderEmpty('无法加载 questions.json。请用本地静态服务器打开 web/index.html。');
    return;
  }

  const data = await res.json();
  const meta = data.meta || {};
  const questions = data.questions || [];

  const questionsById = {};
  const questionIds = [];
  for (const q of questions) {
    const id = String(q.id);
    questionsById[id] = q;
    questionIds.push(id);
  }

  let state = loadState();
  if (!state || state.version !== 1 || !Array.isArray(state.questionIds)) {
    state = makeInitialState(questionIds);
    saveState(state);
  } else {
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
      saveState(state);
    }
  }

  function rerender() {
    renderProgress(meta, state);
    renderQuestion(questionsById, state);
  }

  $('answerForm').addEventListener('submit', (e) => {
    e.preventDefault();

    const activeIds = getActiveIds(state);
    if (activeIds.length === 0) return;

    const qid = activeIds[getActiveIndex(state)];
    const q = questionsById[qid];
    if (!q) return;

    if (state.answers?.[qid]) return;

    const response = collectResponse(q);
    const correct = grade(q, response);

    state.answers[qid] = {
      response,
      correct,
      ts: Date.now(),
    };

    saveState(state);
    rerender();
  });

  $('nextBtn').addEventListener('click', () => {
    const activeIds = getActiveIds(state);
    if (activeIds.length === 0) return;

    const idx = getActiveIndex(state);
    if (idx + 1 < activeIds.length) {
      setActiveIndex(state, idx + 1);
      saveState(state);
      rerender();
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
    saveState(state);
    rerender();
  });

  $('resetBtn').addEventListener('click', () => {
    const ok = confirm('确定要清空全部答题记录吗？');
    if (!ok) return;
    state = makeInitialState(questionIds);
    saveState(state);
    rerender();
  });

  rerender();
}

main().catch((err) => {
  console.error(err);
  renderEmpty('加载失败：请查看控制台错误。');
});
