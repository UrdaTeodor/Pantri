// More: settings, locations, categories, waste report, backup & restore, help.

import { html, useState, useEffect, useRef } from './lib.js';
import { navigate, showToast, pickSheet, promptSheet, confirmSheet, ask } from './nav.js';
import { useApp, Header, Icon, Empty, siteContext } from './kit.js';
import { undoToast } from './sheets.js';
import { locationTree, descendants, wasteSummary, ymd, siteSettings } from '../model.js';
import { dateText, dayText, qtyText, fmtNum, ago } from '../format.js';
import {
  updateSettings, addLocation, renameLocation, moveLocation, shiftLocation, deleteLocation,
  addCategory, renameCategory, deleteCategory, exportJson, importJson, markBackedUp, eraseAll,
  deleteWasteEvent, setSiteSchedule,
} from '../store.js';
import { isPersisted, requestPersistence } from '../db.js';

const LINKS = [
  ['settings', 'sliders', 'Office hours & settings', 'Office days, closures, warnings, order cycle'],
  ['locations', 'pin', 'Locations & sites', 'Sites (Office, Corp House…), rooms, fridges, shelves'],
  ['categories', 'tag', 'Categories', 'Drinks, snacks, cleaning…'],
  ['waste', 'trash', 'Waste report', 'What got thrown away, and what to buy less of'],
  ['backup', 'shield', 'Backup & restore', 'Save your pantry to a file'],
  ['help', 'help', 'How it works', 'Estimates, checks and reorder suggestions'],
];

/** Ask the service worker which build is running ('dev' when served locally). */
function useAppVersion() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) return;
    const ch = new MessageChannel();
    ch.port1.onmessage = e => setVersion(e.data && (e.data.dev ? 'dev' : e.data.version));
    sw.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
  }, []);
  return version;
}

export function More() {
  const { state, now } = useApp();
  const version = useAppVersion();
  const last = state.meta.lastBackupAt;
  return html`
    <${Header} title="More" />
    <main class="page">
      <div class="card list">
        ${LINKS.map(([to, icon, title, sub]) => html`
          <button class="row" key=${to} onClick=${() => navigate(`#/${to}`)}>
            <span class="row-icon"><${Icon} name=${icon} /></span>
            <span class="row-main">
              <span class="row-title">${title}</span>
              <span class="row-sub">${to === 'backup' ? (last ? `Last backup ${dayText(last, now)}` : 'No backup yet') : sub}</span>
            </span>
            <${Icon} name="chevron" />
          </button>`)}
      </div>
      <p class="muted center small">Office Pantry${version ? ` · version ${version}` : ''} · your data stays on this phone</p>
    </main>`;
}

// ---------- settings ----------

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

/** "Mon–Fri 09:00–18:00", "every day, all day", … */
function scheduleText(s) {
  const set = new Set(s.workdays);
  const days = set.size === 7 ? 'every day'
    : [1, 2, 3, 4, 5].every(d => set.has(d)) && set.size === 5 ? 'Mon–Fri'
      : DAYS.filter(([d]) => set.has(d)).map(([, l]) => l).join(', ');
  const allDay = s.dayEnd <= s.dayStart;
  return `${days}${allDay ? ', all day' : ` ${s.dayStart}–${s.dayEnd}`}`;
}

function SiteSchedule({ site, settings, close }) {
  const cur = site.schedule;
  const [custom, setCustom] = useState(!!cur);
  const [days, setDays] = useState((cur && cur.workdays) || settings.workdays);
  const [start, setStart] = useState((cur && cur.dayStart) || settings.dayStart);
  const [end, setEnd] = useState((cur && cur.dayEnd) || settings.dayEnd);
  const [holidays, setHolidays] = useState(cur ? cur.holidays !== false : true);
  const toggle = d => {
    const next = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort();
    if (next.length) setDays(next);
  };
  const save = () => {
    setSiteSchedule(site.id, custom ? { workdays: days, dayStart: start, dayEnd: end, holidays } : null);
    showToast(`${site.name}: ${custom ? scheduleText({ workdays: days, dayStart: start, dayEnd: end }) : 'default hours'}`);
    close(true);
  };
  return html`
    <div class="sheet-pad">
      <h2>${site.name}: when is it in use?</h2>
      <p class="muted">Usage estimates for this site only count during these hours.</p>
      <label class="switch">
        <input type="checkbox" checked=${!custom} onChange=${e => setCustom(!e.target.checked)} />
        <span>Same as the default office hours (${scheduleText(settings)})</span>
      </label>
      ${custom && html`
        <div class="field">
          <label>Days</label>
          <div class="chips">
            ${DAYS.map(([d, label]) => html`
              <button type="button" class=${`chip-btn${days.includes(d) ? ' on' : ''}`} aria-pressed=${days.includes(d)} onClick=${() => toggle(d)}>${label}</button>`)}
          </div>
        </div>
        <div class="two">
          <div class="field"><label>From</label><input class="input" type="time" value=${start} onChange=${e => e.target.value && setStart(e.target.value)} /></div>
          <div class="field"><label>Until</label><input class="input" type="time" value=${end} onChange=${e => e.target.value && setEnd(e.target.value)} /></div>
        </div>
        <button type="button" class="link-btn" onClick=${() => { setDays([0, 1, 2, 3, 4, 5, 6]); setStart('00:00'); setEnd('00:00'); }}>
          Used any time (every day, all day)
        </button>
        <label class="switch">
          <input type="checkbox" checked=${holidays} onChange=${e => setHolidays(e.target.checked)} />
          <span>Office closures (holidays) apply here too</span>
        </label>`}
      <button class="btn primary block" onClick=${save}>Save</button>
    </div>`;
}

function NumberSetting({ label, hint, value, min = 0, max = 365, onSave }) {
  return html`
    <div class="field">
      <label>${label}</label>
      <input class="input num" type="number" inputmode="numeric" min=${min} max=${max} value=${value}
        onChange=${e => {
          const v = Math.round(Number(e.target.value));
          if (Number.isFinite(v) && v >= min && v <= max) onSave(v);
          else e.target.value = value;
        }} />
      ${hint && html`<p class="hint">${hint}</p>`}
    </div>`;
}

export function Settings() {
  const { state, now } = useApp();
  const s = state.settings;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');

  const toggleDay = d => {
    const next = s.workdays.includes(d) ? s.workdays.filter(x => x !== d) : [...s.workdays, d];
    if (!next.length) return showToast('Keep at least one office day');
    updateSettings({ workdays: next.sort() });
  };
  const addClosed = e => {
    e.preventDefault();
    if (!from) return;
    const end = to && to >= from ? to : from;
    updateSettings({ closed: [...s.closed, { from, to: end, note: note.trim() }].sort((a, b) => a.from.localeCompare(b.from)) });
    setFrom('');
    setTo('');
    setNote('');
  };
  const today = ymd(now);
  const closed = s.closed.filter(c => (c.to || c.from) >= today);
  const { multi } = siteContext(state);

  return html`
    <${Header} title="Settings" back="#/more" />
    <main class="page">
      <section class="section">
        <h2 class="section-title">${multi ? 'Default office hours' : 'Office hours'}</h2>
        <div class="card pad">
          <p class="hint">
            Usage rates only count while the office is open, so evenings, weekends and holidays don't "use up" stock.
            ${multi && ' A site can have its own hours: Locations & sites → tap the site.'}
          </p>
          <div class="field">
            <label>Office days</label>
            <div class="chips">
              ${DAYS.map(([d, label]) => html`
                <button type="button" class=${`chip-btn${s.workdays.includes(d) ? ' on' : ''}`} aria-pressed=${s.workdays.includes(d)} onClick=${() => toggleDay(d)}>${label}</button>`)}
            </div>
          </div>
          <div class="two">
            <div class="field"><label>Opens</label><input class="input" type="time" value=${s.dayStart} onChange=${e => e.target.value && updateSettings({ dayStart: e.target.value })} /></div>
            <div class="field"><label>Closes</label><input class="input" type="time" value=${s.dayEnd} onChange=${e => e.target.value && updateSettings({ dayEnd: e.target.value })} /></div>
          </div>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">Office closed (holidays)</h2>
        <div class="card list">
          ${closed.map(c => html`
            <div class="row" key=${c.from + c.to}>
              <span class="row-main">
                <span class="row-title">${dateText(new Date(c.from + 'T00:00').getTime(), now)}${c.to && c.to !== c.from ? ` – ${dateText(new Date(c.to + 'T00:00').getTime(), now)}` : ''}</span>
                ${c.note && html`<span class="row-sub">${c.note}</span>`}
              </span>
              <button class="icon-btn" aria-label="Remove" onClick=${() => updateSettings({ closed: s.closed.filter(x => x !== c) })}><${Icon} name="x" size=${18} /></button>
            </div>`)}
          <form class="pad" onSubmit=${addClosed}>
            <div class="two">
              <div class="field"><label>From</label><input class="input" type="date" value=${from} onInput=${e => setFrom(e.target.value)} /></div>
              <div class="field"><label>To</label><input class="input" type="date" value=${to} min=${from} onInput=${e => setTo(e.target.value)} /></div>
            </div>
            <div class="field"><input class="input" placeholder="Note (optional), e.g. Christmas" value=${note} onInput=${e => setNote(e.target.value)} /></div>
            <button class="btn block" disabled=${!from}>Add closure</button>
          </form>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">Reminders</h2>
        <div class="card pad">
          <${NumberSetting} label="Warn about expiry (days before)" value=${s.warnDays} min=${0} max=${90}
            hint="Items appear under “Use soon” this many days before their date." onSave=${v => updateSettings({ warnDays: v })} />
          <${NumberSetting} label="I order every … days" value=${s.orderEveryDays} min=${1} max=${90}
            hint="The reorder list includes anything that will run out within this many days, and suggests enough to last until the next order." onSave=${v => updateSettings({ orderEveryDays: v })} />
          <${NumberSetting} label="Re-check untouched items after … days" value=${s.staleDays} min=${0} max=${365}
            hint="0 turns this off." onSave=${v => updateSettings({ staleDays: v })} />
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">Scanning</h2>
        <div class="card pad">
          <label class="switch">
            <input type="checkbox" checked=${s.lookup} onChange=${e => updateSettings({ lookup: e.target.checked })} />
            <span>Look up new barcodes online (Open Food Facts)</span>
          </label>
          <label class="switch">
            <input type="checkbox" checked=${s.scanSound} onChange=${e => updateSettings({ scanSound: e.target.checked })} />
            <span>Beep when a barcode is read</span>
          </label>
        </div>
      </section>
    </main>`;
}

// ---------- locations ----------

export function Locations() {
  const { state, info } = useApp();
  const tree = locationTree(state.locations);
  const counts = new Map();
  for (const i of info.values()) {
    for (const id of new Set(i.batches.filter(b => b.present).map(b => b.batch.locationId))) counts.set(id, (counts.get(id) || 0) + 1);
  }

  const add = async (parentId = null) => {
    const parent = parentId && state.locations.find(l => l.id === parentId);
    const name = await promptSheet({
      title: parent ? `New place inside ${parent.name}` : 'New site (building, flat…)',
      placeholder: parent ? 'e.g. Top shelf' : 'e.g. Corp House',
    });
    if (name) addLocation(name, parentId);
  };

  const editHours = site => ask(close => html`<${SiteSchedule} site=${site} settings=${state.settings} close=${close} />`);

  const menu = async t => {
    const l = t.loc;
    const isSite = !l.parentId;
    const v = await pickSheet({
      title: t.path,
      options: [
        ...(isSite ? [{ label: 'Opening days & hours…', sub: scheduleText(siteSettings(state.settings, l)), value: 'hours' }] : []),
        { label: 'Rename', value: 'rename' },
        { label: 'Add a place inside it', value: 'child' },
        { label: 'Move up', value: 'up' },
        { label: 'Move down', value: 'down' },
        { label: 'Move into another location…', value: 'move' },
        { label: 'Delete', sub: 'Stock and sub-locations move to the parent', value: 'delete', danger: true },
      ],
    });
    if (v === 'hours') editHours(l);
    else if (v === 'rename') {
      const name = await promptSheet({ title: 'Rename', value: l.name });
      if (name) renameLocation(l.id, name);
    } else if (v === 'child') add(l.id);
    else if (v === 'up' || v === 'down') shiftLocation(l.id, v === 'up' ? -1 : 1);
    else if (v === 'move') {
      const banned = descendants(state.locations, l.id);
      const target = await pickSheet({
        title: `Move ${l.name} into…`,
        options: [
          { label: 'Top level', value: '__top' },
          ...tree.filter(x => x.loc.id !== l.id && !banned.has(x.loc.id)).map(x => ({ label: x.path, value: x.loc.id })),
        ],
      });
      if (target) moveLocation(l.id, target === '__top' ? null : target);
    } else if (v === 'delete') {
      if (await confirmSheet({ title: `Delete ${l.name}?`, body: 'Anything stored there, and any places inside it, move up one level.', ok: 'Delete', danger: true })) {
        deleteLocation(l.id);
        undoToast(`Deleted ${l.name}`);
      }
    }
  };

  return html`
    <${Header} title="Locations & sites" back="#/more" />
    <main class="page">
      <p class="section-hint">
        Top-level locations are <b>sites</b> — e.g. Office, Corp House, Vlad's apt. Each site gets its own stock, reminders and
        reorder list. Inside a site, organise rooms, fridges and shelves as deep as you like. Tap a location for options.
      </p>
      ${tree.length ? html`
        <div class="card list">
          ${tree.map(t => html`
            <div class="row" key=${t.loc.id} style=${`padding-left:${16 + t.depth * 22}px`}>
              <span class=${`row-icon${t.depth ? ' small' : ''}`}><${Icon} name=${t.depth ? 'pin' : 'home'} size=${18} /></span>
              <button class="row-main bare-btn" onClick=${() => menu(t)}>
                <span class="row-title">${t.loc.name}</span>
                <span class="row-sub">
                  ${!t.depth && html`<span class="chip info">site</span> `}
                  ${counts.get(t.loc.id) ? `${counts.get(t.loc.id)} products` : t.depth ? 'empty' : ''}
                  ${!t.depth && t.loc.schedule ? ` · ${scheduleText(siteSettings(state.settings, t.loc))}` : ''}
                </span>
              </button>
              <button class="icon-btn" aria-label=${`Add a place inside ${t.loc.name}`} onClick=${() => add(t.loc.id)}><${Icon} name="plus" size=${18} /></button>
            </div>`)}
        </div>` : html`<${Empty} icon="pin" title="No locations yet" />`}
      <button class="btn block" onClick=${() => add(null)}><${Icon} name="plus" size=${18} /> Add a site</button>
    </main>`;
}

// ---------- categories ----------

export function Categories() {
  const { state } = useApp();
  const list = [...state.categories].sort((a, b) => a.order - b.order);
  const n = id => state.products.filter(p => p.categoryId === id).length;
  const menu = async c => {
    const v = await pickSheet({
      title: c.name,
      options: [{ label: 'Rename', value: 'rename' }, { label: 'Delete', sub: 'Products keep existing, without a category', value: 'delete', danger: true }],
    });
    if (v === 'rename') {
      const name = await promptSheet({ title: 'Rename category', value: c.name });
      if (name) renameCategory(c.id, name);
    } else if (v === 'delete') {
      deleteCategory(c.id);
      undoToast(`Deleted ${c.name}`);
    }
  };
  const add = async () => {
    const name = await promptSheet({ title: 'New category', placeholder: 'e.g. Breakfast' });
    if (name) addCategory(name);
  };
  return html`
    <${Header} title="Categories" back="#/more" />
    <main class="page">
      <div class="card list">
        ${list.map(c => html`
          <button class="row" key=${c.id} onClick=${() => menu(c)}>
            <span class="row-main"><span class="row-title">${c.name}</span><span class="row-sub">${n(c.id)} products</span></span>
            <${Icon} name="dots" />
          </button>`)}
      </div>
      <button class="btn block" onClick=${add}><${Icon} name="plus" size=${18} /> Add category</button>
    </main>`;
}

// ---------- waste ----------

const REASON = { expired: 'expired', spoiled: 'spoiled', other: 'other' };

export function Waste() {
  const { state, now } = useApp();
  const w30 = wasteSummary(state, now, 30);
  const w90 = wasteSummary(state, now, 90);
  const log = state.events.filter(e => e.type === 'waste').sort((a, b) => b.at - a.at).slice(0, 100);
  const products = new Map(state.products.map(p => [p.id, p]));
  const flagged = w90.rows.filter(r => r.buyLess);
  return html`
    <${Header} title="Waste report" back="#/more" />
    <main class="page">
      <div class="tiles">
        <div class="tile"><b>${w30.times}</b><span>throw-outs<br />last 30 days</span></div>
        <div class="tile"><b>${w90.times}</b><span>throw-outs<br />last 90 days</span></div>
        <div class="tile"><b>${fmtNum(w90.units)}</b><span>units wasted<br />last 90 days</span></div>
      </div>

      ${flagged.length > 0 && html`
        <section class="section">
          <h2 class="section-title">Consider buying less</h2>
          <div class="card list">
            ${flagged.map(r => html`
              <button class="row" key=${r.productId || r.name} onClick=${() => r.productId && products.has(r.productId) && navigate(`#/product/${r.productId}`)}>
                <span class="row-icon warn-text"><${Icon} name="bulb" /></span>
                <span class="row-main">
                  <span class="row-title">${r.name}</span>
                  <span class="row-sub">Thrown out ${r.times}× (${qtyText(r.wasted, r.unit)})${r.share != null ? ` — ${Math.round(r.share * 100)}% of what was bought` : ''}</span>
                </span>
              </button>`)}
          </div>
        </section>`}

      <section class="section">
        <h2 class="section-title">Log</h2>
        ${log.length ? html`
          <div class="card list">
            ${log.map(e => html`
              <div class="row" key=${e.id}>
                <span class="row-main">
                  <span class="row-title">${(products.get(e.productId) || e).name}</span>
                  <span class="row-sub">${qtyText(e.qty, (products.get(e.productId) || e).unit)} · ${REASON[e.reason] || e.reason} · ${ago(e.at, now)}</span>
                </span>
                <button class="icon-btn" aria-label="Delete entry" onClick=${() => { deleteWasteEvent(e.id); undoToast('Entry deleted'); }}><${Icon} name="x" size=${18} /></button>
              </div>`)}
          </div>` : html`<${Empty} icon="trash" title="Nothing thrown away yet">When you throw something out, tap “Thrown away” on it — it shows up here.<//>`}
      </section>
    </main>`;
}

// ---------- backup ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function Backup() {
  const { state, now } = useApp();
  const [persisted, setPersisted] = useState(null);
  const file = useRef(null);
  useEffect(() => {
    isPersisted().then(setPersisted);
  }, []);
  const last = state.meta.lastBackupAt;
  const name = `office-pantry-backup-${ymd(now)}`;

  const save = () => {
    download(`${name}.json`, exportJson(), 'application/json');
    markBackedUp();
    showToast('Backup saved to your downloads');
  };
  const share = async () => {
    const f = new File([exportJson()], `${name}.txt`, { type: 'text/plain' });
    try {
      await navigator.share({ files: [f], title: 'Office Pantry backup' });
      markBackedUp();
    } catch (e) {
      if (e.name !== 'AbortError') showToast('Sharing failed — use “Save backup file” instead');
    }
  };
  const canShareFile = (() => {
    try {
      return !!navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] });
    } catch {
      return false;
    }
  })();

  const restore = async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const text = await f.text();
    if (!(await confirmSheet({ title: 'Replace everything with this backup?', body: `Your current pantry (${state.products.length} products) is replaced by the file's contents.`, ok: 'Restore', danger: true }))) return;
    try {
      importJson(text);
      undoToast('Backup restored');
    } catch (err) {
      showToast(err.message || 'That file could not be read');
    }
  };

  const erase = async () => {
    if (!(await confirmSheet({ title: 'Erase all data?', body: 'Products, stock, history and settings on this phone are deleted. Save a backup first if you might need them.', ok: 'Erase everything', danger: true }))) return;
    eraseAll();
    undoToast('All data erased');
  };

  const protect = async () => {
    const ok = await requestPersistence();
    setPersisted(ok);
    showToast(ok ? 'Storage protected' : 'The browser declined — installing the app usually allows it');
  };

  return html`
    <${Header} title="Backup & restore" back="#/more" />
    <main class="page">
      <div class="card pad">
        <p>Your pantry is stored only in this app on this phone. Save a backup file now and then — for example to Google Drive or by emailing it to yourself.</p>
        <p class="muted">Last backup: ${last ? `${dayText(last, now)} (${dateText(last, now)})` : 'never'}</p>
        <button class="btn primary block" onClick=${save}><${Icon} name="download" size=${18} /> Save backup file</button>
        ${canShareFile && html`<button class="btn block" onClick=${share}><${Icon} name="share" size=${18} /> Share backup (Drive, email…)</button>`}
        <button class="btn block" onClick=${() => file.current.click()}><${Icon} name="upload" size=${18} /> Restore from a backup file</button>
        <input ref=${file} type="file" accept=".json,.txt,application/json,text/plain" hidden onChange=${restore} />
      </div>

      <section class="section">
        <h2 class="section-title">Storage</h2>
        <div class="card pad">
          ${persisted === true && html`<p class="ok-text"><${Icon} name="shield" size=${16} /> Protected — the browser won't clear it to free up space.</p>`}
          ${persisted === false && html`
            <p class="muted">Not protected yet: under heavy storage pressure the browser could clear it.</p>
            <button class="btn block" onClick=${protect}>Protect storage</button>`}
          <p class="muted small">${state.products.length} products · ${state.batches.length} batches · ${state.events.length} history entries</p>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title danger-text">Danger zone</h2>
        <button class="btn danger block" onClick=${erase}><${Icon} name="trash" size=${18} /> Erase all data</button>
      </section>
    </main>`;
}

// ---------- help ----------

export function Help() {
  return html`
    <${Header} title="How it works" back="#/more" />
    <main class="page prose">
      <h2>Usage rates and checks</h2>
      <p>Give a product a usage rate — "5 per office day" for water, "1 per week" for a bag of chips. From the last count, the app estimates what's left, counting time only while the office is open (Settings → office days, hours and closures).</p>
      <p>When the estimate says something is gone or below its minimum, it shows up under <b>Check these</b> on the Today screen. Tap <b>Gone</b>, or set how many are left and tap ✓. "Ask me tomorrow" snoozes it for a day.</p>
      <p>Each count is compared with the estimate. If the real pace is clearly different, the app suggests a better rate — you decide whether to use it.</p>

      <h2>Expiry dates</h2>
      <p>Every delivery is its own batch with its own date, so new stock never hides old stock. Usage is assumed to take the earliest-expiring items first. <b>Use soon</b> lists batches close to their date — and flags ones that, at the current pace, won't be used in time.</p>
      <p>When the quick buttons don't match, type the exact date. If a product has a GS1 DataMatrix code with an expiry date, scanning it fills the date in.</p>

      <h2>Scanning</h2>
      <p>The first scan of a barcode looks it up on Open Food Facts and asks for the details once. After that, scanning opens the product: add stock, count, or log something as thrown away. Set "units per scan" for multipacks (a six-pack = 6 bottles). Scan a different pack of the same thing? Use "link it" to attach the new barcode to the existing product.</p>
      <p><b>Restock</b> (truck icon on Today) keeps the camera open, so you can scan a whole delivery in one go.</p>

      <h2>Reorder list</h2>
      <p>Lists anything out, at or below its minimum, or running out before your next order (Settings → "I order every … days"). The suggested amount covers usage until the next order plus the minimum, rounded up to whole packs where it helps. Tick an item when ordered; adding stock clears it.</p>

      <h2>Several sites</h2>
      <p>Top-level locations are sites — e.g. Office, Corp House and Vlad's apt. Each site keeps its own stock, usage rate, reminders and reorder list for a product, so water drunk at the office doesn't use up the water at the flat.</p>
      <p>With two or more sites, chips at the top of Today, Pantry and Reorder switch between <b>All sites</b> (reminders grouped per site) and a single site. Scanning uses the site you picked. If a barcode is only tracked at another site, one tap starts tracking it here too.</p>
      <p>Each site can have its own opening hours — Locations & sites → tap the site. For a flat, "every day, all day" is usually right.</p>

      <h2>Your data</h2>
      <p>Everything stays on this phone — nothing is uploaded except barcode lookups. Save a backup file regularly (More → Backup & restore).</p>
    </main>`;
}
