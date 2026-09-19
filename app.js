(() => {
  const MAX_PRODUCTS = 50;
  const PARALLEL = 50;
  const BATCH_TIMEOUT_MS = 8000;
  const DEVICE_KEY = 'croma_stock_signal_device_id_v1';
  const DEVICE_COOKIE = 'croma_stock_signal_device_id_v1';
  const SETTINGS_KEY = 'croma_stock_signal_settings_v1';
  const RESULTS_KEY = 'croma_stock_signal_results_v1';
  const state = { running: false, timer: null, wake: null, screenLock: null, screenKeep: true, screenTimer: null, licenseTimer: null, rows: new Map(), muted: false, errorTimer: null, audioContext: null, deviceId: '', licensed: false, requestErrors: 0, lastError: '' };
  const $ = id => document.getElementById(id);
  const mario = $('mario');
  const fallbackAudio = mario.getAttribute('src') || 'mario.mp3.mpeg';
  mario.addEventListener('error', () => {
    if (mario.dataset.fallbackTried) return;
    mario.dataset.fallbackTried = '1';
    mario.src = fallbackAudio;
  });
  mario.src = 'mario.mp3 (2).mpeg';

  function ensureProgressUi() {
    if (!$('progressText')) {
      const progressText = document.createElement('div');
      progressText.id = 'progressText';
      progressText.className = 'progress-text';
      progressText.textContent = 'Ready';
      $('status').after(progressText);
    }
    const style = document.createElement('style');
    style.textContent = '.progress-text{margin-top:6px;color:#666;font-size:12px;line-height:1.2}.offer-list{margin-top:4px;font-size:11px;line-height:1.3;font-weight:600}.chips{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.chip{width:100%;min-width:0;justify-content:space-between;padding:7px 5px;font-size:13px;gap:2px;overflow:visible}.chip span{min-width:0;flex:0 0 auto;overflow:visible;text-overflow:clip;white-space:nowrap}.chip button{flex:0 0 auto;font-size:18px}.product-coupon{display:block;width:100%;margin-top:9px}#mute,#keepAwake{grid-column:1/-1}';
    const productEntryRow = $('addProduct')?.closest('.entry-row');
    const coupon = $('coupon');
    if (productEntryRow && coupon) {
      coupon.classList.add('product-coupon');
      productEntryRow.after(coupon);
    }
    const mute = $('mute');
    if (mute && !$('keepAwake')) {
      const button = document.createElement('button');
      button.id = 'keepAwake';
      button.type = 'button';
      button.className = 'toggle';
      button.addEventListener('click', () => {
        state.screenKeep = !state.screenKeep;
        if (state.screenKeep) keepScreenOn(); else releaseScreenLock();
        updateScreenButton();
      });
      mute.parentElement.append(button);
    }
    updateScreenButton();
    document.head.appendChild(style);
  }

  function getDeviceId() {
    try {
      const nativeId = window.Android?.getDeviceId?.();
      if (nativeId) return `android:${nativeId}`;
    } catch {}
    let cookieId = '';
    try { cookieId = document.cookie.split('; ').find(item => item.startsWith(`${DEVICE_COOKIE}=`))?.split('=').slice(1).join('=') || ''; cookieId = decodeURIComponent(cookieId); } catch {}
    const persist = id => {
      try { localStorage.setItem(DEVICE_KEY, id); } catch {}
      try { document.cookie = `${DEVICE_COOKIE}=${encodeURIComponent(id)}; Max-Age=31536000; Path=/; SameSite=Lax`; } catch {}
    };
    try {
      const stored = localStorage.getItem(DEVICE_KEY);
      if (stored) { persist(stored); return stored; }
    } catch {}
    if (cookieId) { persist(cookieId); return cookieId; }
    const generated = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    persist(generated);
    return generated;
  }

  function spec(value) {
    const key = String(value || '').trim();
    const match = key.match(/^(\d+)([wW][cC])?$/);
    if (!match) return null;
    const suffix = (match[2] || '').toUpperCase();
    return { key, productId: match[1], withoutCoupon: suffix === 'WC' };
  }

  function productKeys(value) {
    return [...new Set(String(value || '').split(/[\s,;]+/).map(spec).filter(Boolean).map(item => item.key))].slice(0, MAX_PRODUCTS);
  }

  function migrateProducts(value) {
    return String(value || '').split(/[\s,;]+/).filter(Boolean).map(item => /^\d+c$/i.test(item) ? item.slice(0, -1) : item).join('\n');
  }

  function pinCodes(value) {
    return [...new Set(String(value || '').split(/[\s,;]+/).map(item => item.trim()).filter(item => /^\d{6}$/.test(item)))];
  }

  function active(row) { return row.available && (!row.offerCheck || row.offerDetected); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }

  function renderChips() {
    const render = (targetId, values) => {
      $(targetId).innerHTML = values.length ? values.map(value => `<span class="chip"><span>${escapeHtml(value)}</span><button type="button" data-remove="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)}">×</button></span>`).join('') : '';
    };
    render('productChips', productKeys($('products').value));
    render('pincodeChips', pinCodes($('pincodes').value));
  }

  function addEntries(sourceId, inputId, kind) {
    const input = $(inputId);
    const incoming = input.value.split(/[\s,;]+/).filter(Boolean);
    if (!incoming.length) return;
    const current = kind === 'products' ? productKeys($(sourceId).value) : pinCodes($(sourceId).value);
    const combined = [...current, ...incoming].join('\n');
    $(sourceId).value = kind === 'products' ? productKeys(combined).join('\n') : pinCodes(combined).join('\n');
    input.value = '';
    $(sourceId).dispatchEvent(new Event('input', { bubbles:true }));
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        products: $('products').value, pincodes: $('pincodes').value, category: $('category').value,
        interval: $('interval').value, coupon: $('coupon').dataset.on === 'true', muted: state.muted
      }));
    } catch {}
  }

  function setCoupon(on, persist = true) {
    $('coupon').dataset.on = String(on);
    $('coupon').textContent = `🎟 Coupon alerts: ${on ? 'ON' : 'OFF'}`;
    $('coupon').classList.toggle('on', on);
    if (persist) saveSettings();
  }

  function setMute() {
    $('mute').textContent = state.muted ? '🔇 Sound muted' : '🔊 Sound on';
    $('mute').classList.toggle('on', state.muted);
  }

  function counts() {
    $('productCount').textContent = `${productKeys($('products').value).length}/${MAX_PRODUCTS} products`;
    $('pinCount').textContent = `${pinCodes($('pincodes').value).length} pincodes`;
    $('parallelCount').textContent = productKeys($('products').value).length * pinCodes($('pincodes').value).length;
    renderChips();
  }

  function updateProgress(completed, total) {
    $('progressText').textContent = `Checking ${completed}/${total} checks · ${total} parallel checks`;
    $('progressBar').style.width = total ? `${completed / total * 100}%` : '0%';
  }

  function renderSignals() {
    const visible = [...state.rows.values()].filter(active).sort((a, b) => a.key.localeCompare(b.key));
    const signals = visible.flatMap(row => row.pincodes.map(pincode => `${row.key} at ${pincode}`));
    $('status').innerHTML = signals.length
      ? signals.map(signal => `<div>${escapeHtml(signal)}</div>`).join('')
      : 'Checking stock...';
    return visible;
  }

  function setNetwork(kind, label) {
    const badge = $('networkStatus');
    badge.textContent = label;
    badge.className = `network network-${kind}`;
  }

  function offerMarkup(value) {
    return String(value || '').split(' | ').filter(Boolean).map(offer => `<div class="offer-list">${escapeHtml(offer)}</div>`).join('');
  }

  function setAccess(allowed, message) {
    state.licensed = allowed;
    $('accessBadge').textContent = allowed ? 'ACTIVE' : 'LOCKED';
    $('accessBadge').className = `access-badge ${allowed ? 'allowed' : 'denied'}`;
    $('accessMessage').textContent = message;
    $('accessModal').style.display = allowed ? 'none' : 'flex';
    $('toolContent').classList.toggle('locked', !allowed);
  }

  function startLicenseMonitor() {
    clearInterval(state.licenseTimer);
    state.licenseTimer = setInterval(() => { if (state.licensed) checkAccess(true); }, 30000);
  }

  async function checkAccess(periodic = false) {
    const wasLicensed = state.licensed;
    if (!periodic || !wasLicensed) setAccess(false, 'Checking this device...');
    try {
      const options = { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ deviceId:state.deviceId }) };
      let response = await fetch('/api/license', options);
      if (response.status === 404) response = await fetch('/API/license', options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `License check failed (${response.status}).`);
      setNetwork('online', '● Network connected');
      if (data.allowed === true) {
        setAccess(true, 'This device is approved for VIP Croma Tools.');
        startLicenseMonitor();
      } else {
        stop();
        setAccess(false, 'Access revoked. This device is not on the approved list.');
      }
    } catch (error) {
      setNetwork(navigator.onLine ? 'error' : 'offline', navigator.onLine ? '⚠ License server error' : '✕ Network disconnected');
      if (wasLicensed && periodic) setAccess(true, `Access check temporarily unavailable. Last approval kept. (${error.message})`);
      else setAccess(false, `Access could not be verified: ${error.message}`);
    }
  }

  function render() {
    const visible = [...state.rows.values()].filter(active).sort((a, b) => a.key.localeCompare(b.key));
    $('results').innerHTML = visible.length ? visible.map(row => { const hasOffer = row.offerCheck && row.offerDetected; return `<tr><td><b>${escapeHtml(row.key)}</b></td><td>${row.pincodes.map(escapeHtml).join(', ')}</td><td class="${hasOffer ? 'offer' : 'stock'}">${hasOffer ? `<b>STOCK WITH OFFER</b>${offerMarkup(row.offerName)}` : 'IN STOCK'}</td></tr>`; }).join('') : '<tr><td class="empty" colspan="3">No qualifying stock yet</td></tr>';
    $('stockCount').textContent = visible.length;
    $('locationCount').textContent = visible.reduce((sum, row) => sum + row.pincodes.length, 0);
    const rowErrors = [...state.rows.values()].reduce((sum, row) => sum + (row.errors?.length || 0), 0);
    $('errorCount').textContent = rowErrors + state.requestErrors;
    $('errorDetail').textContent = state.lastError ? `Last error: ${state.lastError}` : '';
    $('offerNotice').style.display = visible.some(row => row.offerCheck && row.offerDetected) ? 'block' : 'none';
    try { localStorage.setItem(RESULTS_KEY, JSON.stringify([...state.rows.values()].slice(-MAX_PRODUCTS))); } catch {}
  }

  function unlockAudio() {
    try {
      state.audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      state.audioContext.resume();
      const wasMuted = mario.muted;
      mario.muted = true;
      const promise = mario.play();
      if (promise) promise.then(() => { mario.pause(); mario.currentTime = 0; mario.muted = wasMuted; }).catch(() => { mario.muted = wasMuted; });
    } catch {}
  }

  function playMario() {
    if (state.muted || !state.running) return;
    mario.currentTime = 0;
    mario.muted = false;
    mario.play().catch(() => {});
  }

  function beep() {
    if (state.muted) return;
    try {
      state.audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = state.audioContext.createOscillator();
      const gain = state.audioContext.createGain();
      oscillator.frequency.value = 165;
      gain.gain.setValueAtTime(.001, state.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.12, state.audioContext.currentTime + .02);
      gain.gain.exponentialRampToValueAtTime(.001, state.audioContext.currentTime + .42);
      oscillator.connect(gain).connect(state.audioContext.destination);
      oscillator.start(); oscillator.stop(state.audioContext.currentTime + .45);
    } catch {}
  }

  function startErrorAlarm() {
    if (state.errorTimer || state.muted) return;
    beep(); state.errorTimer = setInterval(beep, 1400);
  }

  function stopErrorAlarm() {
    clearInterval(state.errorTimer); state.errorTimer = null;
  }

  function stopMario() {
    mario.pause();
    mario.currentTime = 0;
  }

  function updateScreenButton() {
    const button = $('keepAwake');
    if (!button) return;
    button.textContent = state.screenKeep ? '☀ Screen awake: ON' : '☀ Screen awake: OFF';
    button.classList.toggle('on', state.screenKeep);
  }

  async function keepScreenOn() {
    if (!state.screenKeep || !('wakeLock' in navigator) || state.screenLock) return;
    try { state.screenLock = await navigator.wakeLock.request('screen'); updateScreenButton(); } catch {}
  }

  function releaseScreenLock() {
    if (!state.screenLock) return;
    state.screenLock.release().catch(() => {});
    state.screenLock = null;
    updateScreenButton();
  }

  function startScreenRefresh() {
    clearInterval(state.screenTimer);
    state.screenTimer = setInterval(() => {
      if (!state.running || !state.screenKeep) return;
      releaseScreenLock();
      keepScreenOn();
    }, 15 * 60 * 1000);
  }

  function stopScreenRefresh() {
    clearInterval(state.screenTimer);
    state.screenTimer = null;
  }

  async function requestBatch(jobs) {
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobs, category: $('category').value.trim() || 'mobile', deviceId: state.deviceId }) };
    const fetchPath = async path => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
      try {
        return await fetch(path, { ...options, signal: controller.signal });
      } catch (error) {
        if (error.name === 'AbortError') {
          const timeoutError = new Error(`Stock request timed out after ${BATCH_TIMEOUT_MS / 1000}s.`);
          timeoutError.retryable = true;
          timeoutError.silent = true;
          if (navigator.onLine) setNetwork('online', '● Network connected');
          throw timeoutError;
        }
        error.retryable = true;
        setNetwork('offline', '✕ Network disconnected');
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };
    let response = await fetchPath('/api/stock');
    if (response.status === 404) response = await fetchPath('/API/stock');
    const data = await response.json().catch(() => ({}));
    if (response.status === 403) {
      stop();
      setAccess(false, 'Access revoked. This device is not on the approved list.');
    }
    if (!response.ok) {
      setNetwork('error', response.status === 404 ? '⚠ API not found' : '⚠ API error');
      const error = new Error(data.error || `Stock request failed (${response.status}).`);
      error.retryable = response.status !== 403;
      throw error;
    }
    setNetwork('online', '● Network connected');
    return Array.isArray(data.results) ? data.results : [];
  }

  async function scanOnce() {
    if (!state.running) return;
    const keys = productKeys($('products').value);
    const pins = pinCodes($('pincodes').value);
    if (!keys.length) throw new Error('Add at least one product ID.');
    if (!pins.length) throw new Error('Add at least one six-digit pincode.');
    const allowed = new Set(keys);
    [...state.rows.keys()].forEach(key => { if (!allowed.has(key)) state.rows.delete(key); });
    state.requestErrors = 0;
    state.lastError = '';
    const coupon = $('coupon').dataset.on === 'true';
    const jobs = keys.map(item => spec(item)).filter(Boolean).flatMap(item => pins.map(pincode => ({
      key: item.key, productId: item.productId, pincode,
      offerCheck: !item.withoutCoupon && coupon
    })));
    let completed = 0;
    let hadError = false;
    let errorMessage = '';
    if (![...state.rows.values()].some(active)) $('status').textContent = 'Checking stock...';
    updateProgress(0, jobs.length);
    for (let start = 0; start < jobs.length; start += PARALLEL) {
      const batch = jobs.slice(start, start + PARALLEL);
      let results = [];
      try {
        results = await requestBatch(batch);
      } catch (error) {
        if (!state.running) return;
        hadError = true;
        if (!error.silent) {
          state.requestErrors += 1;
          errorMessage ||= error.message;
          state.lastError = error.message;
        }
      }
      results.forEach(result => {
        const row = state.rows.get(result.key) || { key: result.key, offerCheck: result.offerCheck, offerDetected: result.offerDetected, offerName: result.offerName || '', pincodes: [], errors: [] };
        row.offerCheck = result.offerCheck === true;
        row.offerDetected = result.offerDetected === true;
        row.offerName = result.offerName || '';
        row.pincodes = row.pincodes.filter(pin => pin !== result.pincode);
        row.errors = (row.errors || []).filter(error => error.pincode !== result.pincode);
        if (result.available) row.pincodes.push(result.pincode);
        if (result.error) { row.errors.push({ pincode: result.pincode, message: result.error }); hadError = true; errorMessage ||= result.error; setNetwork('error', '⚠ Croma API error'); }
        row.available = row.pincodes.length > 0;
        state.rows.set(result.key, row);
      });
      completed += batch.length;
      updateProgress(completed, jobs.length);
      renderSignals();
      render();
    }
    if (!state.running) return;
    stopErrorAlarm();
    const visible = renderSignals();
    if (visible.length && !hadError) playMario(); else stopMario();
    state.lastError = hadError ? errorMessage : '';
    render();
  }

  async function start() {
    if (state.running) return;
    if (!state.licensed) { await checkAccess(); if (!state.licensed) return; }
    state.running = true; state.screenKeep = true; $('start').disabled = true; $('start').textContent = '▶ Checking Stock...'; $('stop').disabled = false; saveSettings(); unlockAudio(); keepScreenOn(); startScreenRefresh(); updateScreenButton();
    try {
      while (state.running) {
        try {
          await scanOnce();
        } catch (error) {
          if (!state.running) break;
          state.requestErrors += 1;
          state.lastError = error.message;
          renderSignals();
          stopErrorAlarm(); render();
          if (!error.retryable) { state.running = false; break; }
        }
        if (state.running) await waitForNextScan(Math.max(1, Number($('interval').value) || 1) * 1000);
      }
    } finally {
      clearTimeout(state.timer); state.timer = null; state.wake = null; state.running = false; state.screenKeep = false; stopScreenRefresh(); releaseScreenLock(); $('start').disabled = false; $('stop').disabled = true; updateScreenButton();
    }
  }

  function waitForNextScan(milliseconds) {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(state.timer); state.timer = null; state.wake = null; resolve(); };
      state.wake = finish;
      state.timer = setTimeout(finish, milliseconds);
    });
  }

  function stop() {
    state.running = false;
    clearTimeout(state.timer); state.timer = null;
    if (state.wake) { const wake = state.wake; state.wake = null; wake(); }
    stopErrorAlarm(); stopMario();
    state.screenKeep = false; stopScreenRefresh(); releaseScreenLock(); updateScreenButton();
    $('status').textContent = 'Stopped. Saved results remain below.';
    $('start').disabled = false; $('start').textContent = '▶ Start checking'; $('stop').disabled = true;
  }
  function clearResults() { stop(); stopErrorAlarm(); state.rows.clear(); try { localStorage.removeItem(RESULTS_KEY); } catch {} $('progressBar').style.width = '0'; $('status').textContent = ''; render(); }

  function load() {
    try {
      const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      $('products').value = migrateProducts(settings.products); $('pincodes').value = settings.pincodes || ''; $('category').value = settings.category || 'mobile'; $('interval').value = settings.interval || '1'; state.muted = settings.muted === true; setCoupon(settings.coupon === true, false);
      const results = JSON.parse(localStorage.getItem(RESULTS_KEY) || '[]'); results.forEach(row => state.rows.set(row.key, row));
    } catch {}
    counts(); setMute(); render();
  }

  $('products').addEventListener('input', () => { counts(); saveSettings(); });
  $('pincodes').addEventListener('input', () => { counts(); saveSettings(); });
  $('addProduct').addEventListener('click', () => addEntries('products', 'productEntry', 'products'));
  $('addPincode').addEventListener('click', () => addEntries('pincodes', 'pincodeEntry', 'pincodes'));
  $('productEntry').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addEntries('products', 'productEntry', 'products'); } });
  $('pincodeEntry').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addEntries('pincodes', 'pincodeEntry', 'pincodes'); } });
  $('productChips').addEventListener('click', event => { const button = event.target.closest('[data-remove]'); if (!button) return; $('products').value = productKeys($('products').value).filter(value => value !== button.dataset.remove).join('\n'); $('products').dispatchEvent(new Event('input', { bubbles:true })); });
  $('pincodeChips').addEventListener('click', event => { const button = event.target.closest('[data-remove]'); if (!button) return; $('pincodes').value = pinCodes($('pincodes').value).filter(value => value !== button.dataset.remove).join('\n'); $('pincodes').dispatchEvent(new Event('input', { bubbles:true })); });
  $('category').addEventListener('input', saveSettings); $('interval').addEventListener('change', saveSettings);
  $('coupon').addEventListener('click', () => setCoupon($('coupon').dataset.on !== 'true'));
  $('mute').addEventListener('click', () => { state.muted = !state.muted; if (state.muted) stopErrorAlarm(); setMute(); saveSettings(); });
  $('start').addEventListener('click', start); $('stop').addEventListener('click', stop); $('clear').addEventListener('click', clearResults);
  $('copyDevice').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.deviceId); $('copyDevice').textContent = 'Copied'; setTimeout(() => { $('copyDevice').textContent = 'Copy ID'; }, 1500); } catch { $('accessMessage').textContent = 'Copy failed. Press and hold the Device ID to copy it.'; } });
  $('recheckAccess').addEventListener('click', checkAccess);
  window.addEventListener('online', () => setNetwork('online', '● Network connected'));
  window.addEventListener('offline', () => setNetwork('offline', '✕ Network disconnected'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.running) { keepScreenOn(); if (state.wake) state.wake(); }
  });
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredPrompt = event; $('installBtn').style.display = 'block'; });
  $('installBtn').addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('installBtn').style.display = 'none'; });
  document.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
  ensureProgressUi();
  state.deviceId = getDeviceId();
  $('deviceId').textContent = state.deviceId;
  setNetwork(navigator.onLine ? 'online' : 'offline', navigator.onLine ? '● Network connected' : '✕ Network disconnected');
  load();
  checkAccess();
})();
