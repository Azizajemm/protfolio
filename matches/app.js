/* تطبيق عرض المباريات — يعتمد على واجهة ESPN العامة (بدون مفتاح API) */
(() => {
  'use strict';

  const API = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
  const LIVE_REFRESH_MS = 30_000;
  const IDLE_REFRESH_MS = 5 * 60_000;

  const LEAGUES = [
    { id: 'all',             name: 'الكل',               icon: '🌍' },
    { id: 'uefa.champions',  name: 'دوري أبطال أوروبا',  icon: '🏆' },
    { id: 'eng.1',           name: 'الدوري الإنجليزي',   icon: '🏴' },
    { id: 'esp.1',           name: 'الدوري الإسباني',    icon: '🇪🇸' },
    { id: 'ita.1',           name: 'الدوري الإيطالي',    icon: '🇮🇹' },
    { id: 'ger.1',           name: 'الدوري الألماني',    icon: '🇩🇪' },
    { id: 'fra.1',           name: 'الدوري الفرنسي',     icon: '🇫🇷' },
    { id: 'ksa.1',           name: 'الدوري السعودي',     icon: '🇸🇦' },
    { id: 'mar.1',           name: 'البطولة المغربية',   icon: '🇲🇦' },
    { id: 'uefa.europa',     name: 'الدوري الأوروبي',    icon: '🥈' },
  ];
  const LEAGUE_NAME = Object.fromEntries(LEAGUES.map(l => [l.id, l.name]));

  const state = {
    date: startOfDay(new Date()),
    league: load('league', 'all'),
    filter: 'all',
    query: '',
    favs: new Set(load('favs', [])),
    matches: [],
    timer: null,
  };

  const $ = sel => document.querySelector(sel);
  const el = {
    dates: $('#dates'), leagues: $('#leagues'), content: $('#content'),
    lastUpdate: $('#lastUpdate'), refresh: $('#refreshBtn'), search: $('#search'),
    notice: $('#notice'), dialog: $('#matchDialog'), dialogBody: $('#dialogBody'),
  };

  /* ---------------- Utilities ---------------- */
  function load(key, fallback) {
    try { const v = localStorage.getItem('matches:' + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem('matches:' + key, JSON.stringify(value)); } catch { /* ignore */ }
  }
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function ymd(d) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }
  function sameDay(a, b) { return startOfDay(a).getTime() === startOfDay(b).getTime(); }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const timeFmt = new Intl.DateTimeFormat('ar', { hour: '2-digit', minute: '2-digit', hour12: false, numberingSystem: 'latn' });
  const dayFmt = new Intl.DateTimeFormat('ar', { weekday: 'short' });
  const fullDateFmt = new Intl.DateTimeFormat('ar', { weekday: 'long', day: 'numeric', month: 'long', numberingSystem: 'latn' });

  /* ---------------- Data ---------------- */
  // نجلب نطاق يوم قبل وبعد ثم نصفّي حسب التوقيت المحلي للمستخدم
  async function fetchLeague(leagueId, date) {
    const range = `${ymd(addDays(date, -1))}-${ymd(addDays(date, 1))}`;
    const res = await fetch(`${API}/${leagueId}/scoreboard?dates=${range}&limit=200`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const leagueLogo = data.leagues?.[0]?.logos?.[0]?.href || '';
    return (data.events || []).map(ev => normalize(ev, leagueId, leagueLogo));
  }

  function normalize(ev, leagueId, leagueLogo) {
    const comp = ev.competitions?.[0] || {};
    const side = ha => {
      const c = (comp.competitors || []).find(x => x.homeAway === ha) || {};
      return {
        id: c.team?.id,
        name: c.team?.shortDisplayName || c.team?.displayName || '—',
        logo: c.team?.logo || '',
        score: c.score ?? '',
        winner: !!c.winner,
      };
    };
    const st = ev.status?.type || comp.status?.type || {};
    const home = side('home'), away = side('away');
    return {
      id: ev.id,
      league: leagueId,
      leagueLogo,
      date: new Date(ev.date),
      state: st.state || 'pre',          // pre | in | post
      detail: st.shortDetail || st.detail || '',
      clock: ev.status?.displayClock || '',
      home, away,
      venue: comp.venue?.fullName || '',
      events: (comp.details || []).map(d => ({
        minute: d.clock?.displayValue || '',
        type: d.redCard ? 'red' : d.yellowCard ? 'yellow' : d.scoringPlay ? 'goal' : 'other',
        text: d.type?.text || '',
        player: d.athletesInvolved?.[0]?.displayName || '',
        side: d.team?.id === home.id ? 'home' : 'away',
        ownGoal: !!d.ownGoal, penalty: !!d.penaltyKick,
      })),
    };
  }

  async function loadMatches({ silent = false } = {}) {
    if (!silent) renderLoading();
    el.refresh.classList.add('spin');
    const ids = state.league === 'all' ? LEAGUES.slice(1).map(l => l.id) : [state.league];
    const results = await Promise.allSettled(ids.map(id => fetchLeague(id, state.date)));
    el.refresh.classList.remove('spin');

    const ok = results.filter(r => r.status === 'fulfilled');
    if (!ok.length) {
      state.matches = demoMatches(state.date);
      showNotice('تعذّر الاتصال بمصدر البيانات — يتم عرض بيانات تجريبية.');
    } else {
      state.matches = ok.flatMap(r => r.value).filter(m => sameDay(m.date, state.date));
      hideNotice();
    }
    el.lastUpdate.textContent = `آخر تحديث ${timeFmt.format(new Date())}`;
    render();
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(state.timer);
    const hasLive = state.matches.some(m => m.state === 'in');
    state.timer = setTimeout(() => loadMatches({ silent: true }), hasLive ? LIVE_REFRESH_MS : IDLE_REFRESH_MS);
  }

  /* ---------------- Rendering ---------------- */
  function renderDates() {
    const today = startOfDay(new Date());
    const labels = { '-1': 'أمس', '0': 'اليوم', '1': 'غداً' };
    let html = '';
    for (let i = -3; i <= 7; i++) {
      const d = addDays(today, i);
      const active = sameDay(d, state.date) ? ' active' : '';
      html += `<button class="date-btn${active}" data-offset="${i}">
        <small>${labels[i] || dayFmt.format(d)}</small><strong>${d.getDate()}/${d.getMonth() + 1}</strong></button>`;
    }
    el.dates.innerHTML = html;
    el.dates.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function renderLeagues() {
    el.leagues.innerHTML = LEAGUES.map(l =>
      `<button class="league-tab${l.id === state.league ? ' active' : ''}" role="tab" data-league="${l.id}">
        <span>${l.icon}</span>${l.name}</button>`).join('');
  }

  function renderFilters() {
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.filter === state.filter));
  }

  function renderLoading() {
    el.content.innerHTML = `<section class="league-group">${'<div class="skeleton"></div>'.repeat(5)}</section>`;
  }

  function filtered() {
    const q = state.query.trim().toLowerCase();
    return state.matches.filter(m => {
      if (state.filter === 'live' && m.state !== 'in') return false;
      if (state.filter === 'fav' && !state.favs.has(m.id)) return false;
      if (q && !`${m.home.name} ${m.away.name}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function render() {
    const list = filtered();
    if (!list.length) {
      const msg = state.filter === 'live' ? 'لا توجد مباريات مباشرة الآن'
        : state.filter === 'fav' ? 'لم تضف أي مباراة للمفضلة بعد'
        : 'لا توجد مباريات في هذا اليوم';
      el.content.innerHTML = `<div class="empty"><span class="big">🏟️</span>${msg}</div>`;
      return;
    }
    // ترتيب: المباشر أولاً، ثم القادمة، ثم المنتهية
    const order = { in: 0, pre: 1, post: 2 };
    const groups = new Map();
    list.sort((a, b) => order[a.state] - order[b.state] || a.date - b.date)
        .forEach(m => { if (!groups.has(m.league)) groups.set(m.league, []); groups.get(m.league).push(m); });

    const leagueOrder = LEAGUES.map(l => l.id);
    el.content.innerHTML = [...groups.entries()]
      .sort((a, b) => leagueOrder.indexOf(a[0]) - leagueOrder.indexOf(b[0]))
      .map(([lid, ms]) => `
        <section class="league-group">
          <div class="league-head">
            ${ms[0].leagueLogo ? `<img src="${esc(ms[0].leagueLogo)}" alt="" loading="lazy">` : ''}
            <span>${esc(LEAGUE_NAME[lid] || lid)}</span>
            <span class="count">${ms.length} مباراة</span>
          </div>
          ${ms.map(matchRow).join('')}
        </section>`).join('');
  }

  function teamHtml(t, cls, m) {
    const result = m.state === 'post' && (m.home.winner || m.away.winner) ? (t.winner ? ' winner' : ' loser') : '';
    const logo = t.logo
      ? `<img src="${esc(t.logo)}" alt="" loading="lazy">`
      : `<span class="logo-ph">${esc(t.name.slice(0, 2))}</span>`;
    return `<div class="team ${cls}${result}">${logo}<span class="team-name">${esc(t.name)}</span></div>`;
  }

  function centerHtml(m) {
    if (m.state === 'pre') {
      return `<div class="kickoff">${timeFmt.format(m.date)}</div><div class="status">${m.detail.includes('Postponed') ? 'مؤجلة' : 'لم تبدأ'}</div>`;
    }
    const score = `<div class="score">${esc(m.home.score)} - ${esc(m.away.score)}</div>`;
    if (m.state === 'in') {
      const label = /HT|Half/i.test(m.detail) ? 'استراحة' : esc(m.clock || m.detail);
      return `${score}<div class="status live"><span class="dot"></span><bdi>${label}</bdi></div>`;
    }
    return `${score}<div class="status ft">انتهت</div>`;
  }

  function matchRow(m) {
    const fav = state.favs.has(m.id);
    return `<article class="match${m.state === 'in' ? ' is-live' : ''}" data-id="${esc(m.id)}">
      ${teamHtml(m.home, 'home', m)}
      <div class="center">${centerHtml(m)}</div>
      ${teamHtml(m.away, 'away', m)}
      <button class="fav-btn${fav ? ' on' : ''}" data-fav="${esc(m.id)}" aria-label="مفضلة">${fav ? '★' : '☆'}</button>
    </article>`;
  }

  function openMatch(id) {
    const m = state.matches.find(x => x.id === id);
    if (!m) return;
    const icon = { goal: '⚽', yellow: '🟨', red: '🟥', other: '•' };
    const evs = m.events.filter(e => e.type !== 'other');
    el.dialogBody.innerHTML = `
      <div class="d-league">${esc(LEAGUE_NAME[m.league] || '')}</div>
      <div class="d-teams">
        <div>${m.home.logo ? `<img src="${esc(m.home.logo)}" alt="">` : ''}<div class="name">${esc(m.home.name)}</div></div>
        <div>${m.state === 'pre'
          ? `<div class="d-score">${timeFmt.format(m.date)}</div>`
          : `<div class="d-score">${esc(m.home.score)} - ${esc(m.away.score)}</div>`}
          <div class="status${m.state === 'in' ? ' live' : ''}">${m.state === 'in' ? '<span class="dot"></span><bdi>' + esc(m.clock) + '</bdi>' : m.state === 'post' ? 'انتهت' : 'لم تبدأ'}</div>
        </div>
        <div>${m.away.logo ? `<img src="${esc(m.away.logo)}" alt="">` : ''}<div class="name">${esc(m.away.name)}</div></div>
      </div>
      <div class="d-meta">
        <div>📅 ${fullDateFmt.format(m.date)} — ${timeFmt.format(m.date)}</div>
        ${m.venue ? `<div>🏟️ ${esc(m.venue)}</div>` : ''}
      </div>
      ${evs.length ? `<div class="events"><h3>أحداث المباراة</h3>${evs.map(e => `
        <div class="ev ${e.side}"><span class="min"><bdi>${esc(e.minute)}</bdi></span><span>${icon[e.type]}</span>
        <span>${esc(e.player)}${e.ownGoal ? ' (هدف عكسي)' : ''}${e.penalty ? ' (ركلة جزاء)' : ''}</span></div>`).join('')}</div>` : ''}
    `;
    el.dialog.showModal();
  }

  function showNotice(msg) { el.notice.textContent = msg; el.notice.hidden = false; }
  function hideNotice() { el.notice.hidden = true; }

  /* ---------------- Demo fallback ---------------- */
  function demoMatches(date) {
    const at = (h, m) => { const d = new Date(date); d.setHours(h, m); return d; };
    const mk = (id, league, h, a, hs, as, st, time, clock = '') => ({
      id: 'demo' + id, league, leagueLogo: '', date: time, state: st, detail: '', clock, venue: '',
      home: { name: h, logo: '', score: hs, winner: st === 'post' && hs > as },
      away: { name: a, logo: '', score: as, winner: st === 'post' && as > hs },
      events: st === 'pre' ? [] : [{ minute: "23'", type: 'goal', player: 'لاعب تجريبي', side: 'home' }],
    });
    return [
      mk(1, 'eng.1', 'Arsenal', 'Chelsea', 2, 1, 'in', at(17, 30), "67'"),
      mk(2, 'esp.1', 'Real Madrid', 'Barcelona', '', '', 'pre', at(21, 0)),
      mk(3, 'mar.1', 'Raja', 'Wydad', 1, 1, 'post', at(15, 0)),
      mk(4, 'ksa.1', 'Al Hilal', 'Al Nassr', 3, 2, 'post', at(19, 0)),
      mk(5, 'uefa.champions', 'Bayern', 'PSG', 0, 0, 'in', at(20, 0), "12'"),
    ];
  }

  /* ---------------- Events ---------------- */
  el.dates.addEventListener('click', e => {
    const b = e.target.closest('.date-btn'); if (!b) return;
    state.date = addDays(startOfDay(new Date()), +b.dataset.offset);
    renderDates(); loadMatches();
  });
  el.leagues.addEventListener('click', e => {
    const b = e.target.closest('.league-tab'); if (!b) return;
    state.league = b.dataset.league; save('league', state.league);
    renderLeagues(); loadMatches();
  });
  document.querySelector('.filters').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    state.filter = c.dataset.filter; renderFilters(); render();
  });
  el.search.addEventListener('input', e => { state.query = e.target.value; render(); });
  el.refresh.addEventListener('click', () => loadMatches({ silent: true }));
  el.content.addEventListener('click', e => {
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.stopPropagation();
      const id = fav.dataset.fav;
      state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
      save('favs', [...state.favs]); render(); return;
    }
    const row = e.target.closest('.match'); if (row) openMatch(row.dataset.id);
  });
  el.dialog.addEventListener('click', e => { if (e.target === el.dialog) el.dialog.close(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadMatches({ silent: true }); });

  /* ---------------- Init ---------------- */
  renderDates(); renderLeagues(); renderFilters(); loadMatches();
})();
