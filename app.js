// ================================================================
// LCSW Voice Note PWA — app.js
// Prototype only — not HIPAA compliant by itself.
// No APIs, no backend, no PHI stored.
// ================================================================

'use strict';

// ── Service Worker ──────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then(() => addAuditEntry('Service worker registered — offline ready'))
      .catch(err => console.warn('SW registration failed:', err));
  });
}

// ── PWA Install ─────────────────────────────────────────────────

let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  showEl('install-banner');
  updatePwaStatus();
});

window.addEventListener('appinstalled', () => {
  hideEl('install-banner');
  _deferredInstallPrompt = null;
  addAuditEntry('PWA installed to home screen');
  updatePwaStatus();
});

function dismissInstallBanner() {
  hideEl('install-banner');
}

// ── State ───────────────────────────────────────────────────────

const state = {
  currentView:       'home',
  noteType:          'SOAP',
  sessionMode:       'typed',
  isSigned:          false,
  isAmendmentMode:   false,
  isRecording:       false,
  hasConsent:        false,
  autoDelete:        true,
  mockEcwLoaded:     false,
  signedAt:          null,
  auditEntries:      [],
  recognition:       null,
  finalTranscript:   '',
  mockRecordTimer:   null
};

// ── Demo Data ───────────────────────────────────────────────────

const FAKE_CLIENTS = [
  { id: 'CLIENT-0042', label: 'Demo Client A  (ID: 0042)' },
  { id: 'CLIENT-0117', label: 'Demo Client B  (ID: 0117)' },
  { id: 'CLIENT-0203', label: 'Demo Client C  (ID: 0203)' },
  { id: 'CLIENT-0388', label: 'Demo Client D  (ID: 0388)' }
];

const FAKE_TRANSCRIPT_LINES = [
  'Client reported feeling overwhelmed this week due to work stress and difficulty sleeping.',
  'Mentioned ongoing conflict with a coworker that has continued for approximately two weeks.',
  'Client completed the thought record worksheet assigned last session and found it somewhat helpful.',
  'Together we identified cognitive distortions including catastrophizing and mind reading.',
  'Client expressed motivation to continue working on coping strategies.',
  'Client denied suicidal ideation, self-harm, or homicidal ideation.',
  'No changes in medications were reported.',
  'Discussed communication strategies for addressing the workplace conflict.',
  'Client demonstrated insight into connection between sleep disruption and mood.',
  'Plan to practice grounding techniques before bed this week.'
];

const FAKE_ECW = {
  patientId:       'PT-00042',
  appointmentDate: new Date().toLocaleDateString('en-US'),
  provider:        'Jane Smith, LCSW',
  encounterType:   'Individual Therapy — 53 min (CPT 90837)'
};

const WRITEBACK_STEPS = [
  { id: 'check-api',    label: 'eCW API access enabled' },
  { id: 'check-reg',    label: 'App registered with eCW' },
  { id: 'check-baa',    label: 'BAA-covered hosting confirmed' },
  { id: 'check-signed', label: 'Therapist reviewed and signed note' },
  { id: 'check-audit',  label: 'Audit log recorded' },
  { id: 'check-secure', label: 'Note transmitted securely' }
];

const SESSION_MODE_LABELS = {
  typed:  'Typed notes',
  record: 'Record/transcribe',
  ai:     'AI-assisted draft'
};

// ── DOM Helpers ─────────────────────────────────────────────────

const $ = id => document.getElementById(id);
function showEl(id) { const e = $(id); if (e) e.classList.remove('hidden'); }
function hideEl(id) { const e = $(id); if (e) e.classList.add('hidden'); }

// ── Init ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  populateClientSelect();
  setTodayDate();
  initOnlineStatus();
  initSpeechRecognition();
  initTabNav();
  bindAllEvents();
  updateDraftStatus();
  syncHomeView();
  updatePwaStatus();
  maybeShowInstallBanner();
  addAuditEntry('App opened');
});

function populateClientSelect() {
  const sel = $('client-select');
  sel.innerHTML = '<option value="">— Select demo client —</option>';
  FAKE_CLIENTS.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.label;
    sel.appendChild(opt);
  });
  sel.value = FAKE_CLIENTS[0].id;
}

function setTodayDate() {
  $('session-date').value = new Date().toISOString().split('T')[0];
}

function maybeShowInstallBanner() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
  if (!isStandalone && !_deferredInstallPrompt) {
    setTimeout(() => showEl('install-banner'), 3000);
  }
}

// ── Tab Navigation ──────────────────────────────────────────────

function initTabNav() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

function switchView(name) {
  if (state.currentView === name) return;
  state.currentView = name;

  // Hide all views, show target
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = $('view-' + name);
  if (target) target.classList.add('active');

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });

  // Scroll view container to top
  const vc = document.querySelector('.view-container');
  if (vc) vc.scrollTop = 0;

  // Sync home if returning to it
  if (name === 'home') syncHomeView();
}

// Expose for onclick attributes in HTML
window.switchView = switchView;

// ── Online / Offline ────────────────────────────────────────────

function initOnlineStatus() {
  renderOnlineStatus();
  window.addEventListener('online',  () => { renderOnlineStatus(); addAuditEntry('Network status: Online'); });
  window.addEventListener('offline', () => { renderOnlineStatus(); addAuditEntry('Network status: Offline'); });
}

function renderOnlineStatus() {
  const el = $('online-indicator');
  const settingsEl = $('settings-online');
  if (navigator.onLine) {
    if (el) { el.textContent = 'Online'; el.className = 'status-pill pill-online'; }
    if (settingsEl) settingsEl.textContent = 'Online';
  } else {
    if (el) { el.textContent = 'Offline'; el.className = 'status-pill pill-offline'; }
    if (settingsEl) settingsEl.textContent = 'Offline (cached)';
  }
}

// ── PWA Status ─────────────────────────────────────────────────

function updatePwaStatus() {
  const el = $('pwa-status-text');
  if (!el) return;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
  el.textContent = isStandalone ? 'Installed' : 'Running in browser';
}

// ── Home View Sync ──────────────────────────────────────────────

function syncHomeView() {
  const clientEl = $('home-client');
  const dateEl   = $('home-date');
  const typeEl   = $('home-note-type');
  const modeEl   = $('home-mode');

  if (clientEl) {
    const sel = $('client-select');
    const chosen = sel && sel.value
      ? FAKE_CLIENTS.find(c => c.id === sel.value)
      : null;
    clientEl.textContent = chosen
      ? chosen.label.split('(')[0].trim()
      : 'None selected';
  }

  if (dateEl) {
    const d = $('session-date') && $('session-date').value;
    dateEl.textContent = d
      ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
  }

  if (typeEl) typeEl.textContent = noteTypeFull(state.noteType);
  if (modeEl) modeEl.textContent = SESSION_MODE_LABELS[state.sessionMode] || state.sessionMode;
}

function renderHomeActivity() {
  const el = $('home-recent-activity');
  if (!el) return;
  const entries = state.auditEntries.slice(-5).reverse();
  if (!entries.length) {
    el.innerHTML = '<p class="empty-state">No activity yet.</p>';
    return;
  }
  el.innerHTML = entries.map(e => {
    const t = new Date(e.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return '<div class="activity-item"><span class="activity-time">' + t + '</span>'
      + '<span class="activity-msg">' + escHtml(e.message) + '</span></div>';
  }).join('');
}

// ── Speech Recognition ──────────────────────────────────────────

function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (event) => {
    let interim = '';
    let addedFinal = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) addedFinal += t + ' ';
      else interim += t;
    }
    state.finalTranscript += addedFinal;
    $('transcript-area').value = state.finalTranscript.trim()
      + (interim ? '\n▶ ' + interim : '');
  };

  rec.onerror = (event) => {
    if (event.error === 'not-allowed') {
      setRecordBadge('stopped', 'Mic denied');
      addAuditEntry('Recording error: microphone permission denied');
      state.isRecording = false;
      updateRecordButtons();
    }
  };

  rec.onend = () => {
    if (state.isRecording) {
      try { rec.start(); } catch (_) {}
    } else {
      const ta = $('transcript-area');
      ta.value = ta.value.split('\n').filter(l => !l.startsWith('▶')).join('\n').trim();
    }
  };

  state.recognition = rec;
}

// ── Event Bindings ──────────────────────────────────────────────

function bindAllEvents() {
  // Session setup
  $('note-type').addEventListener('change', e => {
    state.noteType = e.target.value;
    syncHomeView();
  });
  $('session-mode').addEventListener('change', e => {
    state.sessionMode = e.target.value;
    syncHomeView();
  });
  $('client-select').addEventListener('change', syncHomeView);
  $('session-date').addEventListener('change', syncHomeView);

  // Recording
  $('consent-checkbox').addEventListener('change', e => {
    state.hasConsent = e.target.checked;
    if (!state.hasConsent && state.isRecording) stopRecording();
    updateRecordButtons();
  });

  $('auto-delete-toggle').addEventListener('change', e => {
    state.autoDelete = e.target.checked;
  });

  $('btn-start-record').addEventListener('click',    startRecording);
  $('btn-stop-record').addEventListener('click',     stopRecording);
  $('btn-use-transcript').addEventListener('click',  useTranscriptAsRoughNotes);
  $('btn-clear-transcript').addEventListener('click',clearTranscript);

  // Rough notes
  $('btn-generate-draft').addEventListener('click', generateDraftNote);

  // Draft — sync export on edit
  $('draft-note').addEventListener('input', () => {
    if (!state.isSigned) syncExportBox();
  });

  // Sign
  $('btn-sign').addEventListener('click',           signNote);
  $('btn-unlock').addEventListener('click',         showUnlockPanel);
  $('btn-confirm-unlock').addEventListener('click', confirmUnlock);
  $('btn-cancel-unlock').addEventListener('click',  cancelUnlock);

  // Export
  $('btn-copy-ecw').addEventListener('click',      copyForEcw);
  $('btn-download-txt').addEventListener('click',  downloadTxt);
  $('btn-download-html').addEventListener('click', downloadHtml);

  // eCW mocks
  $('btn-load-ecw').addEventListener('click',           loadMockEcwContext);
  $('btn-simulate-writeback').addEventListener('click', simulateWriteback);

  // Settings
  $('btn-copy-audit').addEventListener('click',    copyAuditLog);
  $('btn-reset-session').addEventListener('click', resetSession);
}

// ── Recording ───────────────────────────────────────────────────

function startRecording() {
  if (!state.hasConsent) return;
  state.isRecording = true;
  state.finalTranscript = '';
  $('transcript-area').value = '';

  if (state.recognition) {
    try {
      state.recognition.start();
      setRecordBadge('recording', 'Recording');
      addAuditEntry('Recording started (browser SpeechRecognition)');
    } catch (_) {
      fallbackMockRecord();
    }
  } else {
    fallbackMockRecord();
    setRecordBadge('recording', 'Recording (mock)');
    addAuditEntry('Recording started — mock mode');
  }

  updateRecordButtons();
}

function fallbackMockRecord() {
  let idx = 0;
  let acc = '';

  const tick = () => {
    if (!state.isRecording) return;
    if (idx < FAKE_TRANSCRIPT_LINES.length) {
      acc += (acc ? '\n' : '') + FAKE_TRANSCRIPT_LINES[idx++];
      $('transcript-area').value = acc + '\n▶ [recording…]';
      state.mockRecordTimer = setTimeout(tick, 2200);
    }
  };
  state.mockRecordTimer = setTimeout(tick, 1400);
}

function stopRecording() {
  state.isRecording = false;

  if (state.mockRecordTimer) {
    clearTimeout(state.mockRecordTimer);
    state.mockRecordTimer = null;
    const ta = $('transcript-area');
    ta.value = ta.value.replace(/\n?▶ \[recording…\]$/, '').trim();
  }

  if (state.recognition) {
    try { state.recognition.stop(); } catch (_) {}
  }

  setRecordBadge('stopped', 'Stopped');
  addAuditEntry('Recording stopped');
  updateRecordButtons();

  setTimeout(() => {
    setRecordBadge('complete', 'Ready');
    addAuditEntry('Transcript generated');
  }, 700);
}

function setRecordBadge(type, text) {
  const el = $('recording-status-badge');
  if (!el) return;
  el.textContent = text;
  el.className = 'status-pill';
  const map = { recording: 'pill-recording', stopped: 'pill-stopped', complete: 'pill-complete' };
  el.classList.add(map[type] || 'pill-neutral');
}

function updateRecordButtons() {
  $('btn-start-record').disabled = !state.hasConsent || state.isRecording;
  $('btn-stop-record').disabled  = !state.isRecording;
}

function useTranscriptAsRoughNotes() {
  const transcript = $('transcript-area').value
    .split('\n').filter(l => !l.startsWith('▶')).join('\n').trim();

  if (!transcript) {
    showToast('No transcript yet — record or type one first.');
    return;
  }
  const existing = $('rough-notes').value.trim();
  $('rough-notes').value = existing
    ? existing + '\n\n[From Transcript]\n' + transcript
    : '[From Transcript]\n' + transcript;

  addAuditEntry('Transcript used as rough notes');
  showToast('Added to rough notes');
}

function clearTranscript() {
  $('transcript-area').value = '';
  state.finalTranscript = '';
  setRecordBadge('neutral', 'Not recording');
  addAuditEntry('Transcript cleared');
}

// ── Draft Generation ────────────────────────────────────────────

function generateDraftNote() {
  const roughNotes = $('rough-notes').value.trim();
  const transcriptLines = $('transcript-area').value
    .split('\n').filter(l => !l.startsWith('▶')).join('\n').trim();

  if (!roughNotes && !transcriptLines) {
    showToast('Add rough notes or a transcript first.');
    return;
  }

  let combined = roughNotes;
  if (transcriptLines && transcriptLines !== roughNotes) {
    combined += (combined ? '\n\n' : '') + transcriptLines;
  }

  const clientId    = $('client-select').value || 'DEMO-CLIENT';
  const sessionDate = $('session-date').value  || new Date().toISOString().split('T')[0];
  const noteType    = $('note-type').value;

  const generated = buildNote(noteType, combined, clientId, sessionDate, 'Jane Smith, LCSW (Demo)');

  $('draft-note').value = generated;
  syncExportBox();
  addAuditEntry('Draft note generated — type: ' + noteTypeFull(noteType));
  showToast('Draft generated — review before signing');
  switchView('draft');
}

function buildNote(type, content, clientId, date, provider) {
  const generatedAt = new Date().toLocaleString();

  const header = [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '[DRAFT — NOT YET SIGNED]',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'Client:     ' + clientId,
    'Date:       ' + date,
    'Provider:   ' + provider,
    'Note Type:  ' + noteTypeFull(type),
    'Generated:  ' + generatedAt,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ''
  ].join('\n');

  const lines = content.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const sections = classifyLines(lines, type);

  let body = '';

  if (type === 'SOAP') {
    body = [
      'SUBJECTIVE:',
      sections[0] || '[Therapist: add client self-report, presenting concerns, mood, affect]',
      '',
      'OBJECTIVE:',
      sections[1] || 'Client presented via telehealth/in-person. Appearance and behavior within normal limits. Affect congruent with reported mood. [Therapist: add MSE observations]',
      '',
      'ASSESSMENT:',
      sections[2] || '[Therapist: add clinical impression, diagnosis, progress toward treatment goals]',
      '',
      'PLAN:',
      sections[3] || '- Continue current treatment approach\n- Homework assigned: [specify]\n- Next session scheduled in approximately 1 week\n- [Therapist: update safety plan status if applicable]'
    ].join('\n');

  } else if (type === 'DAP') {
    body = [
      'DATA:',
      sections[0] || '[Therapist: add session data — what occurred, client report, behaviors observed]',
      '',
      'ASSESSMENT:',
      sections[1] || '[Therapist: add clinical assessment, progress toward goals, barriers]',
      '',
      'PLAN:',
      sections[2] || '- Continue current treatment\n- Homework: [specify]\n- Next session in approximately 1 week'
    ].join('\n');

  } else if (type === 'BIRP') {
    body = [
      'BEHAVIOR:',
      sections[0] || '[Therapist: describe presenting behaviors, client self-report, affect, demeanor]',
      '',
      'INTERVENTION:',
      sections[1] || '[Therapist: list interventions — CBT, DBT, motivational interviewing, psychoeducation, etc.]',
      '',
      'RESPONSE:',
      sections[2] || '[Therapist: describe client response to interventions, engagement, insight]',
      '',
      'PLAN:',
      sections[3] || '- Continue current modality\n- Homework: [specify]\n- Next session in approximately 1 week'
    ].join('\n');

  } else {
    body = [
      'SESSION SUMMARY:',
      sections[0] || '[Therapist: summarize session focus, key themes, primary content discussed]',
      '',
      'INTERVENTIONS USED:',
      sections[1] || '[Therapist: list modalities and specific interventions]',
      '',
      'CLIENT RESPONSE:',
      sections[2] || '[Therapist: describe client engagement, comprehension, and progress]',
      '',
      'PLAN:',
      sections[3] || '- Continue current treatment\n- Homework: [specify]\n- Next session in approximately 1 week'
    ].join('\n');
  }

  const footer = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'SAFETY: Client denied suicidal ideation, self-harm, and homicidal ideation this session.',
    '[Therapist: revise if safety assessment differs]',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'PROTOTYPE ONLY — Review and verify all content before entering into EHR.',
    ''
  ].join('\n');

  return header + body + footer;
}

function noteTypeFull(type) {
  return { SOAP: 'SOAP Note', DAP: 'DAP Note', BIRP: 'BIRP Note', Brief: 'Brief Progress Note' }[type] || type;
}

function classifyLines(lines, type) {
  const KEYWORDS = {
    SOAP: [
      ['reported', 'stated', 'said', 'felt', 'feeling', 'described', 'expressed', 'complained', 'denied', 'mentioned'],
      ['observed', 'appear', 'mental status', 'affect', 'behavior', 'present', 'demeanor', 'eye contact', 'speech', 'mood'],
      ['assessment', 'diagnosis', 'impression', 'progress', 'improve', 'insight', 'barrier', 'clinical'],
      ['plan', 'homework', 'continue', 'next session', 'follow', 'practice', 'assign', 'goal', 'schedule']
    ],
    DAP: [
      ['reported', 'stated', 'said', 'felt', 'feeling', 'described', 'expressed', 'discussed', 'client', 'mentioned'],
      ['assessment', 'impression', 'progress', 'insight', 'identified', 'barrier', 'clinical', 'diagnosis'],
      ['plan', 'homework', 'continue', 'next session', 'follow', 'practice', 'assign', 'schedule']
    ],
    BIRP: [
      ['reported', 'stated', 'said', 'felt', 'feeling', 'described', 'appear', 'behavior', 'expressed', 'mood', 'affect', 'denied'],
      ['used', 'intervention', 'technique', 'cbt', 'dbt', 'mindfulness', 'practiced', 'worksheet', 'together', 'grounding', 'identified'],
      ['response', 'responded', 'engaged', 'motivated', 'receptive', 'insight', 'helpful', 'demonstrated'],
      ['plan', 'homework', 'continue', 'next session', 'follow', 'practice', 'assign', 'schedule']
    ],
    Brief: [
      ['reported', 'stated', 'discussed', 'focused', 'session', 'week', 'client', 'felt', 'feeling', 'denied'],
      ['used', 'intervention', 'technique', 'cbt', 'mindfulness', 'worksheet', 'practiced', 'grounding', 'together'],
      ['response', 'responded', 'engaged', 'client', 'helpful', 'motivated', 'insight', 'demonstrated'],
      ['plan', 'homework', 'continue', 'next session', 'assign', 'practice', 'schedule']
    ]
  };

  const kwSets = KEYWORDS[type] || KEYWORDS.SOAP;
  const buckets = kwSets.map(() => []);

  lines.forEach(line => {
    const lower = line.toLowerCase();
    let bestIdx = 0, bestScore = 0;
    kwSets.forEach((kws, i) => {
      const score = kws.reduce((a, kw) => a + (lower.includes(kw) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    });
    buckets[Math.min(bestIdx, buckets.length - 1)].push(line);
  });

  return buckets.map(b => b.join('\n'));
}

// ── Draft Status ────────────────────────────────────────────────

function updateDraftStatus() {
  const headerBadge = $('note-status-badge');
  const signBadge   = $('sign-status-text');
  const labelEl     = $('draft-note-label');
  const tsEl        = $('draft-timestamp');
  const draftTA     = $('draft-note');
  const genBtn      = $('btn-generate-draft');

  if (state.isSigned && !state.isAmendmentMode) {
    if (headerBadge) { headerBadge.textContent = 'Signed'; headerBadge.className = 'status-pill pill-signed'; }
    if (signBadge)   { signBadge.textContent = 'Signed / Locked'; signBadge.className = 'status-pill pill-signed'; }
    if (labelEl)     labelEl.textContent = 'Signed Note';
    if (tsEl)        tsEl.textContent = state.signedAt ? 'Signed ' + state.signedAt : '';
    if (draftTA)     draftTA.disabled = true;
    if (genBtn)      genBtn.disabled = true;

  } else if (state.isAmendmentMode) {
    if (headerBadge) { headerBadge.textContent = 'Amendment'; headerBadge.className = 'status-pill pill-amendment'; }
    if (signBadge)   { signBadge.textContent = 'Amendment Mode'; signBadge.className = 'status-pill pill-amendment'; }
    if (labelEl)     labelEl.textContent = 'Amendment Mode — Editing Enabled';
    if (tsEl)        tsEl.textContent = '';
    if (draftTA)     draftTA.disabled = false;
    if (genBtn)      genBtn.disabled = false;

  } else {
    if (headerBadge) { headerBadge.textContent = 'Draft'; headerBadge.className = 'status-pill pill-draft'; }
    if (signBadge)   { signBadge.textContent = 'Unsigned'; signBadge.className = 'status-pill pill-neutral'; }
    if (labelEl)     labelEl.textContent = 'Draft Clinical Note';
    if (tsEl)        tsEl.textContent = '';
    if (draftTA)     draftTA.disabled = false;
    if (genBtn)      genBtn.disabled = false;
  }
}

// ── Sign / Lock ─────────────────────────────────────────────────

function signNote() {
  const draft = $('draft-note').value.trim();
  if (!draft) { showToast('Generate a draft note before signing.'); return; }

  state.isSigned        = true;
  state.isAmendmentMode = false;
  state.signedAt        = new Date().toLocaleString();

  $('draft-note').value = $('draft-note').value
    .replace('[DRAFT — NOT YET SIGNED]', '[SIGNED — ' + state.signedAt + ']');

  showEl('signed-info');
  const tsd = $('sign-timestamp-display');
  if (tsd) tsd.textContent = 'Signed ' + state.signedAt;

  showEl('btn-unlock');
  hideEl('btn-sign');
  hideEl('amendment-panel');
  hideEl('amendment-error');

  updateDraftStatus();
  syncExportBox();
  addAuditEntry('Note signed and locked — Jane Smith, LCSW (Demo)');
  showToast('Note signed and locked');
}

function showUnlockPanel() {
  showEl('amendment-panel');
  hideEl('amendment-error');
  const ar = $('amendment-reason');
  if (ar) { ar.value = ''; ar.focus(); }
}

function cancelUnlock() {
  hideEl('amendment-panel');
  hideEl('amendment-error');
}

function confirmUnlock() {
  const reason = $('amendment-reason').value.trim();
  if (!reason) { showEl('amendment-error'); return; }
  hideEl('amendment-error');

  state.isSigned        = false;
  state.isAmendmentMode = true;

  $('draft-note').value = $('draft-note').value
    .replace(/\[SIGNED — [^\]]+\]/, '[AMENDMENT MODE — Editing re-enabled]');

  hideEl('signed-info');
  showEl('btn-sign');
  hideEl('btn-unlock');
  hideEl('amendment-panel');

  updateDraftStatus();
  addAuditEntry('Note unlocked for amendment — reason documented by provider');
  showToast('Note unlocked — amendment mode active');
}

// ── Export ──────────────────────────────────────────────────────

function syncExportBox() {
  const eb = $('ecw-paste-format');
  if (eb) eb.value = $('draft-note').value.trim();
}

function copyForEcw() {
  const text = $('ecw-paste-format').value.trim();
  if (!text) { showToast('Generate a note first.'); return; }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => { showToast('Copied to clipboard'); addAuditEntry('Note copied for eCW paste'); })
      .catch(() => legacyCopy(text));
  } else {
    legacyCopy(text);
  }
}

function legacyCopy(text) {
  const ta = $('ecw-paste-format');
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Copied to clipboard');
    addAuditEntry('Note copied for eCW paste');
  } catch (_) {
    showToast('Copy failed — select text manually');
  }
}

function downloadTxt() {
  const text = $('draft-note').value.trim();
  if (!text) { showToast('Generate a note first.'); return; }
  const clientId = $('client-select').value || 'DEMO';
  const date     = $('session-date').value   || 'DATE';
  const filename = 'LCSW_Note_' + clientId + '_' + date + '.txt';
  triggerDownload(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
  addAuditEntry('Note downloaded as TXT: ' + filename);
}

function downloadHtml() {
  const text = $('draft-note').value.trim();
  if (!text) { showToast('Generate a note first.'); return; }
  const clientId  = $('client-select').value || 'DEMO';
  const date      = $('session-date').value   || 'DATE';
  const noteLabel = noteTypeFull($('note-type').value);
  const filename  = 'LCSW_Note_' + clientId + '_' + date + '.html';
  const html      = buildPrintableHtml(text, clientId, date, 'Jane Smith, LCSW (Demo)', noteLabel);
  triggerDownload(new Blob([html], { type: 'text/html;charset=utf-8' }), filename);
  addAuditEntry('Note downloaded as printable HTML: ' + filename);
}

function buildPrintableHtml(noteText, clientId, date, provider, noteLabel) {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
    + '<meta charset="UTF-8">\n'
    + '<title>Clinical Note — ' + escHtml(clientId) + ' — ' + escHtml(date) + '</title>\n'
    + '<style>\n'
    + '  body{font-family:Georgia,serif;max-width:680px;margin:40px auto;padding:0 24px;color:#111;font-size:14px;line-height:1.75}\n'
    + '  h1{font-size:17px;border-bottom:2px solid #2563eb;padding-bottom:8px;color:#1e3a8a;margin-bottom:16px}\n'
    + '  .meta{background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:12px 16px;margin-bottom:20px;font-size:13px}\n'
    + '  .meta p{margin:3px 0}\n'
    + '  pre{white-space:pre-wrap;font-family:Georgia,serif;font-size:14px;line-height:1.75;margin:0}\n'
    + '  .disc{margin-top:32px;padding:12px 14px;background:#fef2f2;border:1px solid #fca5a5;border-left:4px solid #ef4444;border-radius:6px;font-size:12px;color:#7f1d1d;line-height:1.6}\n'
    + '  @media print{body{margin:20px}.disc{border:1px solid #ccc;background:#fafafa;color:#555}}\n'
    + '</style>\n</head>\n<body>\n'
    + '<h1>' + escHtml(noteLabel) + '</h1>\n'
    + '<div class="meta">'
    + '<p><strong>Client:</strong> ' + escHtml(clientId) + '</p>'
    + '<p><strong>Date:</strong> ' + escHtml(date) + '</p>'
    + '<p><strong>Provider:</strong> ' + escHtml(provider) + '</p>'
    + '<p><strong>Generated:</strong> ' + escHtml(new Date().toLocaleString()) + '</p>'
    + '</div>\n'
    + '<pre>' + escHtml(noteText) + '</pre>\n'
    + '<div class="disc"><strong>Prototype only — not HIPAA compliant by itself.</strong> '
    + 'Review, edit, and enter into EHR manually. Demo data only.</div>\n'
    + '</body>\n</html>';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── eCW Mocks ───────────────────────────────────────────────────

function loadMockEcwContext() {
  [['ecw-patient-id', FAKE_ECW.patientId],
   ['ecw-appt-date',  FAKE_ECW.appointmentDate],
   ['ecw-provider',   FAKE_ECW.provider],
   ['ecw-encounter',  FAKE_ECW.encounterType]
  ].forEach(([id, val]) => {
    const el = $(id);
    if (el) { el.textContent = val; el.classList.remove('empty'); }
  });
  state.mockEcwLoaded = true;
  addAuditEntry('Mock eCW context loaded — demo data only');
  showToast('Mock eCW context loaded');
}

function simulateWriteback() {
  WRITEBACK_STEPS.forEach(s => {
    const el = $(s.id);
    if (el) { el.textContent = s.label; el.classList.remove('checked'); }
  });
  hideEl('writeback-status');
  $('btn-simulate-writeback').disabled = true;

  WRITEBACK_STEPS.forEach((step, i) => {
    setTimeout(() => {
      const el = $(step.id);
      if (el) { el.textContent = step.label; el.classList.add('checked'); }
    }, 350 + i * 420);
  });

  const totalDelay = 350 + WRITEBACK_STEPS.length * 420 + 200;
  setTimeout(() => {
    showEl('writeback-status');
    addAuditEntry('Mock eCW writeback simulated — no data sent');
    showToast('Simulation complete — no data sent');
    setTimeout(() => {
      WRITEBACK_STEPS.forEach(s => {
        const el = $(s.id);
        if (el) { el.textContent = s.label; el.classList.remove('checked'); }
      });
      hideEl('writeback-status');
      $('btn-simulate-writeback').disabled = false;
    }, 6000);
  }, totalDelay);
}

// ── Reset Session ───────────────────────────────────────────────

function resetSession() {
  if (!confirm('Clear all notes, transcript, and recording state for a fresh demo session?')) return;

  state.isSigned        = false;
  state.isAmendmentMode = false;
  state.isRecording     = false;
  state.hasConsent      = false;
  state.signedAt        = null;
  state.finalTranscript = '';
  state.noteType        = 'SOAP';
  state.sessionMode     = 'typed';
  state.mockEcwLoaded   = false;

  $('client-select').value   = FAKE_CLIENTS[0].id;
  $('session-date').value    = new Date().toISOString().split('T')[0];
  $('note-type').value       = 'SOAP';
  $('session-mode').value    = 'typed';
  $('consent-checkbox').checked = false;
  $('transcript-area').value = '';
  $('rough-notes').value     = '';
  $('draft-note').value      = '';
  $('ecw-paste-format').value = '';
  $('amendment-reason').value = '';

  hideEl('signed-info');
  hideEl('btn-unlock');
  showEl('btn-sign');
  hideEl('amendment-panel');
  hideEl('amendment-error');
  hideEl('writeback-status');

  ['ecw-patient-id','ecw-appt-date','ecw-provider','ecw-encounter'].forEach(id => {
    const el = $(id);
    if (el) { el.textContent = '—'; el.classList.add('empty'); }
  });

  WRITEBACK_STEPS.forEach(s => {
    const el = $(s.id);
    if (el) { el.textContent = s.label; el.classList.remove('checked'); }
  });

  setRecordBadge('neutral', 'Not recording');
  updateRecordButtons();
  updateDraftStatus();
  syncHomeView();
  addAuditEntry('Demo session reset');
  showToast('Session cleared');
}

// ── Audit Log ───────────────────────────────────────────────────

function addAuditEntry(message) {
  state.auditEntries.push({ ts: new Date().toISOString(), message });
  renderAuditLog();
  renderHomeActivity();
}

function renderAuditLog() {
  const log = $('audit-log');
  if (!log) return;
  log.innerHTML = state.auditEntries.map(e => {
    const time = new Date(e.ts).toLocaleTimeString('en-US', { hour12: false });
    return '<div class="audit-entry"><span class="audit-time">[' + time + ']</span> '
      + escHtml(e.message) + '</div>';
  }).join('');
  log.scrollTop = log.scrollHeight;
}

function copyAuditLog() {
  const text = state.auditEntries.map(e => '[' + e.ts + '] ' + e.message).join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Audit log copied'))
      .catch(() => showToast('Copy failed'));
  } else {
    showToast('Copy not supported — select manually');
  }
}

// ── Toast ───────────────────────────────────────────────────────

function showToast(message) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className   = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-visible')));
  setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.remove(), 250);
  }, 2600);
}
