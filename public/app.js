const api = {
  start: '/api/draft/start',
  spinTeam: '/api/draft/spin-team',
  openSlotPicker: '/api/draft/open-slot-picker',
  cancelSlotPicker: '/api/draft/cancel-slot-picker',
  search: '/api/draft/search',
  pick: '/api/draft/pick',
  simulate: '/api/match/simulate'
};

const clientState = {
  draftId: null,
  formation: '4-3-3',
  busy: false
};

function qs(selector) {
  return document.querySelector(selector);
}

function showScreen(name) {
  const normalized = name[0].toUpperCase() + name.slice(1);
  document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('is-active'));
  const target = qs(`#screen${normalized}`);
  if (target) target.classList.add('is-active');
  window.scrollTo({ top: 0, behavior: 'auto' });
}

async function request(url, payload = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request gagal.');
  return data;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function patchText(items = {}) {
  Object.entries(items).forEach(([selector, value]) => {
    const el = qs(selector);
    if (el) el.textContent = value;
  });
}

function patchHtml(items = {}) {
  Object.entries(items).forEach(([selector, html]) => {
    const el = qs(selector);
    if (!el) return;
    if (selector === '#slotPicker') {
      el.outerHTML = html;
      return;
    }
    el.innerHTML = html;
  });
}

function patchClasses(items = {}) {
  Object.entries(items).forEach(([selector, rule]) => {
    const el = qs(selector);
    if (!el) return;
    (rule.add || []).forEach(name => el.classList.add(name));
    (rule.remove || []).forEach(name => el.classList.remove(name));
  });
}

function patchProps(items = {}) {
  Object.entries(items).forEach(([selector, props]) => {
    const el = qs(selector);
    if (!el) return;
    Object.entries(props || {}).forEach(([name, value]) => {
      if (name === 'disabled') {
        el.dataset.serverDisabled = value ? '1' : '0';
      }

      if (name in el) el[name] = value;
      else if (value === false || value === null) el.removeAttribute(name);
      else el.setAttribute(name, String(value));
    });
  });
}

function applyPatches(patches = {}) {
  patchText(patches.text);
  patchHtml(patches.html);
  patchClasses(patches.classes);
  patchProps(patches.props);
  if (patches.screen) showScreen(patches.screen);
}

function setBusy(button, busy, mode = 'normal') {
  clientState.busy = busy;

  if (!busy) {
    qs('#teamSpinBox')?.classList.remove('is-spinning');
    qs('#yearSpinBox')?.classList.remove('is-spinning');
  }

  if (!button) return;

  const serverDisabled = button.dataset.serverDisabled === '1';
  button.disabled = busy || serverDisabled;
  button.classList.toggle('is-spinning', busy);

  const isSpinAction = button.id === 'btnSpinTeam' || button.id === 'btnRespinAll' || button.id === 'btnRespinTeam';
  if (!isSpinAction) return;

  if (busy) {
    if (button.id === 'btnRespinTeam' || mode === 'year') {
      qs('#yearSpinBox')?.classList.add('is-spinning');
    } else {
      qs('#teamSpinBox')?.classList.add('is-spinning');
      qs('#yearSpinBox')?.classList.add('is-spinning');
    }

    const label = qs('#btnSpinTeam .spin-label');
    if (button.id === 'btnSpinTeam' && label) label.textContent = 'MEMUTAR';
  }
}

async function startDraft(button) {
  const selected = qs('.formation-card.is-selected');
  clientState.formation = selected?.dataset.formation || '4-3-3';
  setBusy(button, true);
  const data = await request(api.start, { formation: clientState.formation });
  clientState.draftId = data.draftId;
  applyPatches(data.patches);
  showScreen('draft');
}

async function spinTeam(button, mode) {
  const startedAt = Date.now();
  setBusy(button, true, mode);
  const data = await request(api.spinTeam, { draftId: clientState.draftId, mode });
  const remaining = 650 - (Date.now() - startedAt);
  if (remaining > 0) await wait(remaining);
  applyPatches(data.patches);
}

async function openSlotPicker(button) {
  const data = await request(api.openSlotPicker, {
    draftId: clientState.draftId,
    playerId: button.dataset.playerId
  });
  applyPatches(data.patches);
  qs('#slotPicker')?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
}

async function pickSlot(button) {
  const data = await request(api.pick, {
    draftId: clientState.draftId,
    playerId: button.dataset.playerId,
    slot: button.dataset.slot
  });
  applyPatches(data.patches);
}

async function cancelSlotPicker() {
  const data = await request(api.cancelSlotPicker, { draftId: clientState.draftId });
  applyPatches(data.patches);
}

async function simulate(button) {
  setBusy(button, true);
  button.textContent = 'MENSIMULASIKAN...';
  const data = await request(api.simulate, { draftId: clientState.draftId });
  applyPatches(data.patches);
  button.textContent = 'SIMULASI TURNAMEN';
}

let searchTimer = null;
function searchPlayers(value) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    if (!clientState.draftId) return;
    try {
      const data = await request(api.search, { draftId: clientState.draftId, query: value });
      applyPatches(data.patches);
    } catch (err) {
      console.warn(err.message);
    }
  }, 160);
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || clientState.busy) return;

  try {
    const id = button.id;
    const action = button.dataset.action;

    if (id === 'btnNextSetup') return await startDraft(button);
    if (id === 'btnSpinTeam') return await spinTeam(button, 'normal');
    if (id === 'btnRespinAll') return await spinTeam(button, 'all');
    if (id === 'btnRespinTeam') return await spinTeam(button, 'year');
    if (id === 'btnSimulate') return await simulate(button);
    if (id === 'btnPlayAgain' || id === 'btnHome') return location.reload();
    if (id === 'btnCancelSlotPicker' || action === 'cancel-slot-picker') return await cancelSlotPicker();
    if (action === 'open-slot-picker') return await openSlotPicker(button);
    if (action === 'pick-slot') return await pickSlot(button);

    const formationCard = event.target.closest('.formation-card');
    if (formationCard) {
      document.querySelectorAll('.formation-card').forEach(card => {
        card.classList.toggle('is-selected', card === formationCard);
      });
      clientState.formation = formationCard.dataset.formation || '4-3-3';
    }
  } catch (err) {
    alert(err.message);
  } finally {
    setBusy(button, false);
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'searchInput') searchPlayers(event.target.value);
});
