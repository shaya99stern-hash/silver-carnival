// ================================================================
// LCSW Voice Note PWA — app.js
// Prototype only — not HIPAA compliant by itself.
// No APIs, no backend, no PHI stored.
// ================================================================

'use strict';

// ── Service Worker Registration ─────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then(() => addAuditEntry('Service worker registered (offline cache ready)'))
      .catch(err => console.warn('SW registration failed:', err));
  });
}

// ── PWA Install Prompt ──────────────────────────────────────────

let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  showEl('install-banner');
});

window.addEventListener('appinstalled', () => {
  hideEl('install-banner');
  _deferredInstallPrompt = null;
  addAuditEntry('PWA installed to home screen');
});

function dismissInstallBanner() {
  hideEl('install-banner');
}

// ── State ───────────────────────────────────────────────────────

const state = {
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

// ── Demo / Fake Data ────────────────────────────────────────────

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
  { id: 'check-secure', label: 'Note exported or transmitted securely' }
];

// ── DOM Helpers ─────────────────────────────────────────────────

const $ = id => document.getElementById(id);
function showEl(id) { $(id) && $(id).classList.remove('hidden'); }
function hideEl(id) { $(id) && $(id).classList.add('hidden'); }
function toggleEl(id, show) { show ? showEl(id) : hideEl(id); }

// ── Init ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  populateClientSelect();
  setTodayDate();
  initOnlineStatus();
  initSpeechRecognition();
  bindAllEvents();
  updateDraftStatus();
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
    setTimeout(() => showEl('install-banner'), 2500);
  }
}

// ── Online / Offline ────────────────────────────────────────────

function initOnlineStatus() {
  renderOnlineStatus();
  window.addEventListener('online',  () => { renderOnlineStatus(); addAuditEntry('Network status: Online'); });
  window.addEventListener('offline', () => { renderOnlineStatus(); addAuditEntry('Network status: Offline'); });
}

function renderOnlineStatus() {
  const el = $('online-indicator');
  if (navigator.onLine) {
    el.textContent = '● Online';
    el.className = 'status-badge badge-online';
  } else {
    el.textContent = '● Offline';
    el.className = 'status-badge badge-offline';
  }
}

// ── Speech Recognition Setup ────────────────────────────────────

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
      setRecordBadge('stopped', 'Mic permission denied');
      addAuditEntry('Recording error: microphone permission denied');
      state.isRecording = false;
      updateRecordButtons();
    }
  };

  rec.onend = () => {
    if (state.isRecording) {
      try { rec.start(); } catch (_) {}
    } else {
      // Clean up live-indicator line
      const ta = $('transcript-area');
      ta.value = ta.value.split('\n').filter(l => !l.startsWith('▶')).join('\n').trim();
    }
  };

  state.recognition = rec;
}

// ── Event Bindings ──────────────────────────────────────────────

function bindAllEvents() {
  // Section 1
  $('note-type').addEventListener('change',    e => { state.noteType    = e.target.value; });
  $('session-mode').addEventListener('change', e => { state.sessionMode = e.target.value; });

  // Section 2 — Recording
  $('consent-checkbox').addEventListener('change', e => {
    state.hasConsent = e.target.checked;
    if (!state.hasConsent && state.isRecording) stopRecording();
    updateRecordButtons();
  });

  $('auto-delete-toggle').addEventListener('change', e => {
    state.autoDelete = e.target.checked;
  });

  $('btn-start-record').addEventListener('click',   startRecording);
  $('btn-stop-record').addEventListener('click',    stopRecording);
  $('btn-use-transcript').addEventListener('click', useTranscriptAsRoughNotes);
  $('btn-clear-transcript').addEventListener('click', clearTranscript);

  // Section 3 — Rough notes
  $('rough-notes').addEventListener('input', () => {});
  $('btn-generate-draft').addEventListener('click', generateDraftNote);

  // Section 4 — Draft (updates export box on edit)
  $('draft-note').addEventListener('input', () => {
    if (!state.isSigned) syncExportBox();
  });

  // Section 5 — Sign
  $('btn-sign').addEventListener('click',           signNote);
  $('btn-unlock').addEventListener('click',         showUnlockPanel);
  $('btn-confirm-unlock').addEventListener('click', confirmUnlock);
  $('btn-cancel-unlock').addEventListener('click',  cancelUnlock);

  // Section 6 — Export
  $('btn-copy-ecw').addEventListener('click',     copyForEcw);
  $('btn-download-txt').addEventListener('click', downloadTxt);
  $('btn-download-html').addEventListener('click',downloadHtml);

  // Section 7 — eCW read mock
  $('btn-load-ecw').addEventListener('click', loadMockEcwContext);

  // Section 8 — eCW writeback mock
  $('btn-simulate-writeback').addEventListener('click', simulateWriteback);

  // Section 9 — Audit
  $('btn-copy-audit').addEventListener('click', copyAuditLog);
}

// ── Section 2: Recording ────────────────────────────────────────

function startRecording() {
  if (!state.hasConsent) return;
  state.isRecording = true;
  state.finalTranscript = '';
  $('transcript-area').value = '';

  if (state.recognition) {
    try {
      state.recognition.start();
      setRecordBadge('recording', '● Recording active');
      addAuditEntry('Recording started (browser SpeechRecognition)');
    } catch (_) {
      fallbackMockRecord();
    }
  } else {
    fallbackMockRecord();
    setRecordBadge('recording', '● Recording active (mock)');
    addAuditEntry('Recording started — mock mode (SpeechRecognition not available)');
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

  setRecordBadge('stopped', 'Recording stopped');
  addAuditEntry('Recording stopped');
  updateRecordButtons();

  setTimeout(() => {
    setRecordBadge('complete', 'Transcription mock complete');
    addAuditEntry('Transcript generated');
  }, 700);
}

function setRecordBadge(type, text) {
  const el = $('recording-status-badge');
  el.textContent = text;
  el.className = 'status-badge';
  const map = {
    recording: 'badge-recording',
    stopped:   'badge-stopped',
    complete:  'badge-complete'
  };
  el.classList.add(map[type] || 'badge-neutral');
}

function updateRecordButtons() {
  $('btn-start-record').disabled = !state.hasConsent || state.isRecording;
  $('btn-stop-record').disabled  = !state.isRecording;
}

function useTranscriptAsRoughNotes() {
  const transcript = $('transcript-area').value
    .split('\n').filter(l => !l.startsWith('▶')).join('\n').trim();

  if (!transcript) {
    showToast('No transcript to use yet. Record audio or type into the Transcript field.');
    return;
  }
  const existing = $('rough-notes').value.trim();
  $('rough-notes').value = existing
    ? existing + '\n\n[From Transcript]\n' + transcript
    : '[From Transcript]\n' + transcript;

  addAuditEntry('Transcript used as rough notes');
  showToast('Transcript added to rough notes');
}

function clearTranscript() {
  $('transcript-area').value = '';
  state.finalTranscript = '';
  setRecordBadge('neutral', 'Not recording');
  addAuditEntry('Transcript cleared');
}

// ── Section 3: Draft Generation (mock AI) ──────────────────────

function generateDraftNote() {
  const roughNotes = $('rough-notes').value.trim();
  const transcriptLines = $('transcript-area').value
    .split('\n').filter(l => !l.startsWith('▶')).join('\n').trim();

  if (!roughNotes && !transcriptLines) {
    showToast('Add rough notes or a transcript before generating.');
    return;
  }

  let combined = roughNotes;
  if (transcriptLines && transcriptLines !== roughNotes) {
    combined += (combined ? '\n\n' : '') + transcriptLines;
  }

  const clientId   = $('client-select').value || 'DEMO-CLIENT';
  const sessionDate= $('session-date').value   || new Date().toISOString().split('T')[0];
  const noteType   = $('note-type').value;

  const generated = buildNote(noteType, combined, clientId, sessionDate, 'Jane Smith, LCSW (Demo)');

  $('draft-note').value  = generated;
  syncExportBox();
  addAuditEntry('Draft note generated — type: ' + noteTypeFull(noteType));
  showToast('Draft generated — review carefully before signing');
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
      sections[1] || 'Client presented via telehealth/in-person. Appearance and behavior within normal limits. Affect congruent with reported mood. Eye contact adequate. Speech normal rate and tone. [Therapist: add MSE observations]',
      '',
      'ASSESSMENT:',
      sections[2] || '[Therapist: add clinical impression, diagnosis, progress toward treatment goals, formulation]',
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
      sections[1] || '[Therapist: add clinical assessment, progress toward goals, barriers, formulation]',
      '',
      'PLAN:',
      sections[2] || '- Continue current treatment\n- Homework: [specify]\n- Next session in approximately 1 week\n- [Therapist: update safety/crisis plan if applicable]'
    ].join('\n');

  } else if (type === 'BIRP') {
    body = [
      'BEHAVIOR:',
      sections[0] || '[Therapist: describe presenting behaviors, client self-report, affect, demeanor observed]',
      '',
      'INTERVENTION:',
      sections[1] || '[Therapist: list interventions used — CBT, DBT, motivational interviewing, psychoeducation, etc.]',
      '',
      'RESPONSE:',
      sections[2] || '[Therapist: describe client\'s response to interventions, engagement level, insight demonstrated]',
      '',
      'PLAN:',
      sections[3] || '- Continue current modality\n- Homework: [specify]\n- Next session in approximately 1 week\n- [Therapist: update crisis plan if applicable]'
    ].join('\n');

  } else { // Brief Progress Note
    body = [
      'SESSION SUMMARY:',
      sections[0] || '[Therapist: summarize session focus, key themes, and primary content discussed]',
      '',
      'INTERVENTIONS USED:',
      sections[1] || '[Therapist: list modalities and specific interventions — CBT thought records, mindfulness, grounding, etc.]',
      '',
      'CLIENT RESPONSE:',
      sections[2] || '[Therapist: describe client engagement, comprehension, emotional response, and progress]',
      '',
      'PLAN:',
      sections[3] || '- Continue current treatment\n- Homework: [specify]\n- Next session in approximately 1 week'
    ].join('\n');
  }

  const footer = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'SAFETY: Client denied suicidal ideation, self-harm, and homicidal ideation this session.',
    '[Therapist: revise if accurate safety assessment differs]',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'PROTOTYPE ONLY — Review, edit, and verify all content before entering into EHR.',
    ''
  ].join('\n');

  return header + body + footer;
}

function noteTypeFull(type) {
  return { SOAP: 'SOAP Note', DAP: 'DAP Note', BIRP: 'BIRP Note', Brief: 'Brief Progress Note' }[type] || type;
}

// Keyword-based mock AI content classifier
function classifyLines(lines, type) {
  const KEYWORDS = {
    SOAP: [
      ['reported', 'stated', 'said', 'felt', 'feeling', 'described', 'expressed', 'complained',
       'denied', 'mentioned', 'reported feeling', 'client said', 'client expressed'],
      ['observed', 'appear', 'mental status', 'affect', 'behavior', 'present', 'demeanor',
       'eye contact', 'speech', 'mood'],
      ['assessment', 'diagnosis', 'impression', 'progress', 'improve', 'insight', 'barrier',
       'significant', 'clinical'],
      ['plan', 'homework', 'continue', 'next session', 'follow', 'referral', 'practice',
       'assign', 'goal', 'schedule', 'return']
    ],
    DAP: [
      ['reported', 'stated', 'said', 'felt', 'feeling', 'described', 'expressed', 'discussed',
       'client', 'mentioned', 'conflict', 'week', 'session'],
      ['assessment', 'impression', 'progress', 'insight', 'identified', 'barrier',
       'clinical', 'diagnosis'],
      ['plan', 'homework', 'continue', 'next session', 'follow', 'practice',
       'assign', 'schedule', 'return']
    ],
    BIRP: [
      ['reported', 'stated', 'said', 'felt', 'feeling', 'described', 'appear', 'behavior',
       'expressed', 'mood', 'affect', 'demeanor', 'denied'],
      ['used', 'intervention', 'technique', 'cbt', 'dbt', 'mindfulness', 'practiced',
       'worksheet', 'together', 'grounding', 'explore', 'identified'],
      ['response', 'responded', 'engaged', 'motivated', 'receptive', 'insight',
       'helpful', 'useful', 'demonstrated'],
      ['plan', 'homework', 'continue', 'next session', 'follow', 'practice',
       'assign', 'schedule']
    ],
    Brief: [
      ['reported', 'stated', 'discussed', 'focused', 'session', 'week', 'client',
       'felt', 'feeling', 'conflict', 'stress', 'denied'],
      ['used', 'intervention', 'technique', 'cbt', 'mindfulness', 'worksheet',
       'practiced', 'grounding', 'together', 'explored'],
      ['response', 'responded', 'engaged', 'client', 'helpful', 'motivated', 'insight',
       'demonstrated', 'receptive'],
      ['plan', 'homework', 'continue', 'next session', 'assign', 'practice', 'schedule']
    ]
  };

  const kwSets = KEYWORDS[type] || KEYWORDS.SOAP;
  const buckets = kwSets.map(() => []);

  lines.forEach(line => {
    const lower = line.toLowerCase();
    let bestIdx = 0;
    let bestScore = 0;
    kwSets.forEach((kws, i) => {
      const score = kws.reduce((acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    });
    buckets[Math.min(bestIdx, buckets.length - 1)].push(line);
  });

  return buckets.map(b => b.join('\n'));
}

// ── Section 4: Draft Status ─────────────────────────────────────

function updateDraftStatus() {
  const headerBadge = $('note-status-badge');
  const signBadge   = $('sign-status-text');
  const labelEl     = $('draft-note-label');
  const tsEl        = $('draft-timestamp');
  const draftTA     = $('draft-note');
  const genBtn      = $('btn-generate-draft');

  if (state.isSigned && !state.isAmendmentMode) {
    headerBadge.textContent = 'Signed / Locked';
    headerBadge.className   = 'status-badge badge-signed';
    signBadge.textContent   = 'Signed / Locked';
    signBadge.className     = 'status-badge badge-signed';
    labelEl.textContent     = 'Signed / Locked Note';
    tsEl.textContent        = state.signedAt ? 'Signed: ' + state.signedAt : '';
    draftTA.disabled        = true;
    if (genBtn) genBtn.disabled = true;

  } else if (state.isAmendmentMode) {
    headerBadge.textContent = 'Amendment Mode';
    headerBadge.className   = 'status-badge badge-amendment';
    signBadge.textContent   = 'Amendment Mode';
    signBadge.className     = 'status-badge badge-amendment';
    labelEl.textContent     = 'Amendment Mode — Editing Enabled';
    tsEl.textContent        = '';
    draftTA.disabled        = false;
    if (genBtn) genBtn.disabled = false;

  } else {
    headerBadge.textContent = 'Draft';
    headerBadge.className   = 'status-badge badge-draft';
    signBadge.textContent   = 'Unsigned';
    signBadge.className     = 'status-badge badge-neutral';
    labelEl.textContent     = 'Draft Clinical Note';
    tsEl.textContent        = '';
    draftTA.disabled        = false;
    if (genBtn) genBtn.disabled = false;
  }
}

// ── Section 5: Sign / Lock ──────────────────────────────────────

function signNote() {
  const draft = $('draft-note').value.trim();
  if (!draft) {
    showToast('Generate a draft note before signing.');
    return;
  }

  state.isSigned        = true;
  state.isAmendmentMode = false;
  state.signedAt        = new Date().toLocaleString();

  // Stamp the note text
  const stamped = $('draft-note').value
    .replace('[DRAFT — NOT YET SIGNED]', '[SIGNED — ' + state.signedAt + ']');
  $('draft-note').value = stamped;

  // UI updates
  showEl('signed-info');
  $('sign-timestamp-display').textContent = 'Signed: ' + state.signedAt;
  showEl('btn-unlock');
  hideEl('btn-sign');
  hideEl('amendment-panel');
  hideEl('amendment-error');

  updateDraftStatus();
  syncExportBox();
  addAuditEntry('Note signed and locked — provider: Jane Smith, LCSW (Demo)');
  showToast('Note signed and locked');
}

function showUnlockPanel() {
  showEl('amendment-panel');
  hideEl('amendment-error');
  $('amendment-reason').value = '';
  $('amendment-reason').focus();
}

function cancelUnlock() {
  hideEl('amendment-panel');
  hideEl('amendment-error');
}

function confirmUnlock() {
  const reason = $('amendment-reason').value.trim();
  if (!reason) {
    showEl('amendment-error');
    return;
  }
  hideEl('amendment-error');

  state.isSigned        = false;
  state.isAmendmentMode = true;

  // Update note text
  $('draft-note').value = $('draft-note').value
    .replace(/\[SIGNED — [^\]]+\]/, '[AMENDMENT MODE — Editing re-enabled]');

  // UI updates
  hideEl('signed-info');
  showEl('btn-sign');
  hideEl('btn-unlock');
  hideEl('amendment-panel');

  updateDraftStatus();
  // Log that amendment occurred but not the reason (could contain PHI)
  addAuditEntry('Note unlocked for amendment — amendment reason documented by provider (not logged here to avoid PHI)');
  showToast('Note unlocked — amendment mode active');
}

// ── Section 6: Export ───────────────────────────────────────────

function syncExportBox() {
  $('ecw-paste-format').value = $('draft-note').value.trim();
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
    showToast('Copy failed — please select and copy manually');
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
  const provider  = 'Jane Smith, LCSW (Demo)';
  const noteLabel = noteTypeFull($('note-type').value);
  const filename  = 'LCSW_Note_' + clientId + '_' + date + '.html';
  const html      = buildPrintableHtml(text, clientId, date, provider, noteLabel);
  triggerDownload(new Blob([html], { type: 'text/html;charset=utf-8' }), filename);
  addAuditEntry('Note downloaded as PDF-style HTML: ' + filename);
}

function buildPrintableHtml(noteText, clientId, date, provider, noteLabel) {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<title>Clinical Note — ' + escHtml(clientId) + ' — ' + escHtml(date) + '</title>\n' +
    '<style>\n' +
    '  body { font-family: Georgia, "Times New Roman", serif; max-width: 680px; margin: 40px auto; padding: 0 24px; color: #111; font-size: 14px; line-height: 1.75; }\n' +
    '  h1 { font-size: 17px; border-bottom: 2.5px solid #2563eb; padding-bottom: 8px; color: #1e3a8a; margin-bottom: 16px; }\n' +
    '  .meta { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; }\n' +
    '  .meta p { margin: 3px 0; }\n' +
    '  pre { white-space: pre-wrap; font-family: Georgia, serif; font-size: 14px; line-height: 1.75; margin: 0; }\n' +
    '  .disclaimer { margin-top: 32px; padding: 12px 14px; background: #fef2f2; border: 1px solid #fca5a5; border-left: 4px solid #ef4444; border-radius: 6px; font-size: 12px; color: #7f1d1d; line-height: 1.6; }\n' +
    '  @media print { body { margin: 20px; } .disclaimer { border: 1px solid #ccc; background: #fafafa; color: #555; } }\n' +
    '</style>\n</head>\n<body>\n' +
    '<h1>Clinical Note — ' + escHtml(noteLabel) + '</h1>\n' +
    '<div class="meta">\n' +
    '  <p><strong>Client:</strong> ' + escHtml(clientId) + '</p>\n' +
    '  <p><strong>Session Date:</strong> ' + escHtml(date) + '</p>\n' +
    '  <p><strong>Provider:</strong> ' + escHtml(provider) + '</p>\n' +
    '  <p><strong>Generated:</strong> ' + escHtml(new Date().toLocaleString()) + '</p>\n' +
    '</div>\n' +
    '<pre>' + escHtml(noteText) + '</pre>\n' +
    '<div class="disclaimer">\n' +
    '  <strong>Prototype only — not HIPAA compliant by itself.</strong> This note must be reviewed, ' +
    'edited as needed, and entered into the approved EHR system manually. Demo data only. No real PHI.\n' +
    '</div>\n</body>\n</html>';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

// ── Section 7: eCW Read Mock ────────────────────────────────────

function loadMockEcwContext() {
  const fields = [
    ['ecw-patient-id', FAKE_ECW.patientId],
    ['ecw-appt-date',  FAKE_ECW.appointmentDate],
    ['ecw-provider',   FAKE_ECW.provider],
    ['ecw-encounter',  FAKE_ECW.encounterType]
  ];
  fields.forEach(([id, val]) => {
    const el = $(id);
    if (el) { el.textContent = val; el.classList.remove('empty'); }
  });
  state.mockEcwLoaded = true;
  addAuditEntry('Mock eCW context loaded — demo data only');
  showToast('Mock eCW context loaded');
}

// ── Section 8: eCW Writeback Mock ──────────────────────────────

function simulateWriteback() {
  // Reset first
  WRITEBACK_STEPS.forEach(s => {
    const el = $(s.id);
    if (el) { el.textContent = '❄ ' + s.label; el.classList.remove('checked'); }
  });
  hideEl('writeback-status');
  $('btn-simulate-writeback').disabled = true;

  WRITEBACK_STEPS.forEach((step, i) => {
    setTimeout(() => {
      const el = $(step.id);
      if (el) { el.textContent = '✅ ' + step.label; el.classList.add('checked'); }
    }, 350 + i * 420);
  });

  const totalDelay = 350 + WRITEBACK_STEPS.length * 420 + 200;
  setTimeout(() => {
    showEl('writeback-status');
    addAuditEntry('Mock eCW writeback simulated — no data sent');
    showToast('Mock writeback complete — no data sent');
    // Reset after display
    setTimeout(() => {
      WRITEBACK_STEPS.forEach(s => {
        const el = $(s.id);
        if (el) { el.textContent = '❄ ' + s.label; el.classList.remove('checked'); }
      });
      hideEl('writeback-status');
      $('btn-simulate-writeback').disabled = false;
    }, 7000);
  }, totalDelay);
}

// ── Section 9: Audit Log ────────────────────────────────────────

function addAuditEntry(message) {
  state.auditEntries.push({ ts: new Date().toISOString(), message });
  renderAuditLog();
}

function renderAuditLog() {
  const log = $('audit-log');
  if (!log) return;
  log.innerHTML = state.auditEntries.map(e => {
    const time = new Date(e.ts).toLocaleTimeString('en-US', { hour12: false });
    return '<div class="audit-entry"><span class="audit-time">[' + time + ']</span> ' +
      escHtml(e.message) + '</div>';
  }).join('');
  log.scrollTop = log.scrollHeight;
}

function copyAuditLog() {
  const text = state.auditEntries
    .map(e => '[' + e.ts + '] ' + e.message)
    .join('\n');

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Audit log copied'))
      .catch(() => showToast('Copy failed'));
  } else {
    showToast('Copy not supported — select text manually');
  }
}

// ── Toast Notification ──────────────────────────────────────────

function showToast(message) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className   = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('toast-visible'));
  });
  setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.remove(), 280);
  }, 2600);
}
