// Orchestration : menu, boucle de jeu, entrées clavier, HUD.
(function () {
  const C = window.CFG;
  const $ = (sel) => document.querySelector(sel);

  const canvas = $('#game');
  const renderer = Render.createRenderer(canvas);

  const ui = {
    menu: $('#menu'), menuMsg: $('#menuMsg'),
    name: $('#nameInput'),
    hostBtn: $('#hostBtn'), joinInput: $('#joinInput'), joinBtn: $('#joinBtn'),
    hud: $('#hud'), scoreboard: $('#scoreboard'),
    inviteBar: $('#inviteBar'), inviteLink: $('#inviteLink'), copyBtn: $('#copyBtn'),
    quitBtn: $('#quitBtn'),
  };

  // ---- état global de session ----
  let mode = null;          // 'host' | 'client' | null
  let world = null;         // mode hôte
  let hostNet = null;
  let clientNet = null;
  let myId = null;
  let running = false;
  let rafId = 0;

  // left/right sont maintenus ; jump/attack sont des impulsions accumulées
  // jusqu'au prochain tick (hôte) ou envoi réseau (invité) ; la souris
  // donne la direction de visée (où le bâton frappe)
  const input = {
    left: false, right: false, jump: false, attack: false, throw: false,
    block: false, attackHeld: false,
    mouseX: window.innerWidth / 2, mouseY: window.innerHeight / 2,
  };

  // état distant (mode invité)
  const remote = {
    latest: null,           // dernier snapshot reçu
    pos: new Map(),         // id -> {x,y} interpolé
  };
  window.__remote = remote; // accès console pour déboguer (mode invité)

  // ---- entrées ----
  // e.key (et non e.code) pour respecter la disposition du clavier : sur un
  // AZERTY les touches sous la main gauche produisent q/d/z.
  const KEYS = {
    left: ['arrowleft', 'q', 'a'],
    right: ['arrowright', 'd'],
    jump: ['arrowup', 'z', 'w', ' '],
    attack: ['e', 'x', 'j', 'enter'],
    throw: ['f', 'c'],
  };
  // l'éditeur bloque les contrôles du jeu, sauf pendant l'essai de la map
  function editingNow() {
    return window.Editor && Editor.active && !Editor.testing;
  }
  window.addEventListener('keydown', (e) => {
    if (!running || editingNow()) return;
    const k = e.key.toLowerCase();
    if (KEYS.left.includes(k)) input.left = true;
    else if (KEYS.right.includes(k)) input.right = true;
    else if (KEYS.jump.includes(k)) { e.preventDefault(); if (!e.repeat) input.jump = true; }
    else if (KEYS.attack.includes(k)) {
      if (!e.repeat) input.attack = true;
      input.attackHeld = true;
    }
    else if (KEYS.throw.includes(k)) { if (!e.repeat) input.throw = true; }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (KEYS.left.includes(k)) input.left = false;
    else if (KEYS.right.includes(k)) input.right = false;
    else if (KEYS.attack.includes(k)) input.attackHeld = false;
  });
  window.addEventListener('mousemove', (e) => {
    input.mouseX = e.clientX; input.mouseY = e.clientY;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (!running || editingNow()) return;
    if (e.button === 2) input.block = true;   // clic droit maintenu : bouclier
    else { input.attack = true; input.attackHeld = true; }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) input.block = false;
    else input.attackHeld = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', () => {
    input.left = false; input.right = false;
    input.block = false; input.attackHeld = false;
  });

  // ---- menu ----
  const params = new URLSearchParams(location.search);
  if (params.get('join')) {
    ui.joinInput.value = params.get('join');
    ui.menuMsg.textContent = 'Invitation détectée — choisissez un pseudo puis cliquez sur Rejoindre.';
  }
  ui.name.value = localStorage.getItem('baton-name') || '';

  function playerName() {
    const n = ui.name.value.trim().slice(0, 16) || 'Anonyme';
    localStorage.setItem('baton-name', n);
    return n;
  }

  ui.hostBtn.addEventListener('click', startHost);
  ui.joinBtn.addEventListener('click', startJoin);
  ui.quitBtn.addEventListener('click', quitToMenu);
  ui.copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(ui.inviteLink.value).then(() => {
      ui.copyBtn.textContent = 'Copié !';
      setTimeout(() => { ui.copyBtn.textContent = 'Copier'; }, 1500);
    });
  });

  function showMenu(msg) {
    ui.menu.classList.remove('hidden');
    ui.hud.classList.add('hidden');
    ui.inviteBar.classList.add('hidden');
    ui.menuMsg.textContent = msg || '';
  }

  function enterGame() {
    ui.menu.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    running = true;
    lastFrame = performance.now();
    lastStep = lastFrame;
    accumulator = 0;
    netTimer = 0;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function quitToMenu() {
    running = false;
    if (hostNet) { hostNet.destroy(); hostNet = null; }
    if (clientNet) { clientNet.destroy(); clientNet = null; }
    world = null; mode = null; myId = null;
    remote.latest = null; remote.pos.clear();
    history.replaceState(null, '', location.pathname);
    showMenu('');
  }

  // ---- mode hôte ----
  function startHost() {
    mode = 'host';
    myId = 'me';
    world = new Sim.World();
    window.__world = world; // accès console pour déboguer / modder
    world.addPlayer(myId, playerName());

    hostNet = Net.createHost(world, {
      onReady(id) {
        const url = location.origin + location.pathname + '?join=' + id;
        ui.inviteLink.value = location.protocol === 'file:' ? id : url;
        ui.inviteBar.classList.remove('hidden');
        ui.inviteBar.title = location.protocol === 'file:'
          ? 'Page ouverte en local : partagez ce code, vos copains le collent dans « Rejoindre ».'
          : 'Partagez ce lien à vos copains (4 joueurs max).';
      },
      onError() {
        ui.inviteBar.classList.add('hidden');
      },
      onPlayersChanged() {},
    });
    enterGame();
  }

  // ---- mode invité ----
  function startJoin() {
    let code = ui.joinInput.value.trim();
    if (!code) { ui.menuMsg.textContent = 'Collez un lien ou un code d’invitation.'; return; }
    try {
      const u = new URL(code);
      code = new URLSearchParams(u.search).get('join') || code;
    } catch (_) { /* ce n'était pas une URL : on garde le code brut */ }

    ui.menuMsg.textContent = 'Connexion à l’hôte…';
    mode = 'client';
    clientNet = Net.joinGame(code, playerName(), {
      onInit(msg) {
        myId = msg.you;
        enterGame();
      },
      onState(msg) { remote.latest = msg; },
      onFull() { quitToMenu(); ui.menuMsg.textContent = 'Partie pleine (4 joueurs max), désolé !'; },
      onClose() { quitToMenu(); ui.menuMsg.textContent = 'L’hôte a quitté la partie.'; },
      onError(err) {
        if (!running) {
          quitToMenu();
          ui.menuMsg.textContent = 'Connexion impossible : ' + (err.type || err.message);
        }
      },
    });
  }

  // ---- boucle de jeu ----
  // La simulation et le réseau sont avancés par step(), appelée à la fois
  // par requestAnimationFrame (au premier plan) et par un Web Worker
  // (ci-dessous) : les navigateurs suspendent rAF et ralentissent les
  // timers des onglets masqués, mais pas les Workers. Sans ça, la partie
  // entière gèle pour tous les invités dès que l'hôte change d'onglet.
  let lastFrame = 0;
  let lastStep = 0;
  let accumulator = 0;
  let netTimer = 0;
  let sbTimer = 0;

  function step(now) {
    if (!running) return;
    const dtMs = Math.min(250, now - lastStep);
    if (dtMs <= 0) return;
    lastStep = now;
    if (mode === 'host') {
      // en mode édition la partie est figée (sauf pendant « Tester »),
      // mais on continue d'émettre : les invités voient la map évoluer
      if (editingNow()) {
        accumulator = 0;
        if (hostNet) hostNet.broadcast();
        return;
      }
      accumulator += dtMs;
      let guard = 0;
      while (accumulator >= C.TICK_MS && guard++ < 40) {
        applyLocalInput();
        world.tick(C.TICK_MS);
        accumulator -= C.TICK_MS;
      }
      if (accumulator >= C.TICK_MS) accumulator = 0; // retard irrattrapable
      if (hostNet) hostNet.broadcast();
    } else if (clientNet) {
      netTimer += dtMs;
      if (netTimer >= C.NET_MS) {
        netTimer = 0;
        sendClientInput();
      }
    }
  }

  const ticker = new Worker(URL.createObjectURL(new Blob(
    ['setInterval(function () { postMessage(0); }, ' + C.TICK_MS + ');'],
    { type: 'text/javascript' }
  )));
  ticker.onmessage = () => step(performance.now());

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    if (!running) return;
    step(now);
    const dtMs = Math.min(100, now - lastFrame);
    lastFrame = now;
    const dt = dtMs / 1000;

    let view;
    if (mode === 'host') {
      view = {
        players: [...world.players.values()].map((p) => ({
          id: p.id, n: p.name, c: p.color, f: p.facing,
          hp: p.hp, sh: p.sh, bl: p.blocking ? 1 : 0,
          d: p.dead ? 1 : 0, s: p.score,
          w: p.weapon || 0, mn: p.ammo, mu: p.mu > 0 ? 1 : 0,
          k: p.kame > 0 ? 1 : 0,
          ht: p.ht > 0 ? (p.htCrit ? 2 : 1) : 0,
          b: world.viewPlayer(p),
        })),
        weapons: world.viewWeapons(),
        bullets: world.viewBullets(),
        booms: world.viewBooms(),
        theme: world.theme,
        hazards: world.hazards.map((h) => [h.x, h.y, h.w, h.h]),
        lava: world.lava ? world.lava.y : -1,
        balls: world.balls.map((b) => [b.ax, b.ay, b.x, b.y, b.r]),
        lasers: world.lasers.map((l) => [l.x1, l.y1, l.x2, l.y2, l.on ? 1 : 0]),
        swings: world.swings.map((s) => {
          const q = s.body.getPosition();
          return [s.ax, s.ay, q.x * C.SCALE, q.y * C.SCALE, s.body.getAngle(), s.w];
        }),
        crates: world.crates.map((c) => {
          const q = c.body.getPosition();
          return [q.x * C.SCALE, q.y * C.SCALE, c.body.getAngle(), c.s];
        }),
        plats: world.plats.map((pl) => [pl.x, pl.y, pl.w, pl.h, pl.solid ? 1 : 0,
          pl.off ? 0 : 1, pl.timer > 0 && !pl.off ? 1 : 0,
          pl.ice ? (pl.iceHp < C.ICE_HP * 0.55 ? 2 : 1) : 0]),
        round: {
          n: world.round.n, ph: world.round.phase,
          tm: world.round.timer, w: world.round.winner,
        },
        // pas de bandeau d'attente pendant qu'on construit ou essaie sa map
        waiting: world.players.size < 2 && !(window.Editor && Editor.active),
        testing: window.Editor && Editor.active && Editor.testing,
      };
    } else {
      view = buildRemoteView(dt);
    }

    renderer.draw(view, myId, dt);
    if (window.Editor && Editor.active) Editor.drawOverlay();

    if (now - sbTimer > 400) {
      sbTimer = now;
      updateScoreboard(view.players);
    }
  }

  // angle de visée : de la poitrine de mon personnage vers la souris
  function computeAim() {
    const w = renderer.worldFromScreen(input.mouseX, input.mouseY);
    let px = null, py = null;
    if (mode === 'host') {
      const me = world.players.get(myId);
      if (me) { px = me.x; py = me.y - C.PLAYER.H * 0.55; }
    } else if (remote.latest) {
      // b[0], b[1] = centre du torse (position interpolée si disponible)
      const b = remote.pos.get(myId) ||
        (remote.latest.players.find((p) => p.id === myId) || {}).b;
      if (b) { px = b[0]; py = b[1] - 6; }
    }
    if (px === null) return 0;
    return Math.atan2(w.y - py, w.x - px);
  }

  function applyLocalInput() {
    world.setInput(myId, {
      l: input.left, r: input.right, j: input.jump, a: input.attack,
      ah: input.attackHeld, tr: input.throw, bl: input.block, m: computeAim(),
    });
    input.jump = false; input.attack = false; input.throw = false;
  }

  function sendClientInput() {
    if (!clientNet) return;
    clientNet.sendInput({
      l: input.left, r: input.right, j: input.jump, a: input.attack,
      ah: input.attackHeld, tr: input.throw, bl: input.block,
      m: Math.round(computeAim() * 100) / 100,
    });
    input.jump = false; input.attack = false; input.throw = false;
  }

  // interpolation d'angle par le chemin le plus court
  function lerpAngle(a, b, k) {
    const d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return a + d * k;
  }

  function buildRemoteView(dt) {
    const snap = remote.latest;
    if (!snap) return { players: [], plats: [], round: null, waiting: true };

    // interpolation douce de tous les points du pantin vers le dernier
    // snapshot reçu (les indices 2 et 13 sont des angles)
    const k = Math.min(1, dt * 14);
    const seen = new Set();
    const players = snap.players.map((p) => {
      seen.add(p.id);
      if (!p.b) { remote.pos.delete(p.id); return p; }
      let s = remote.pos.get(p.id);
      // téléporté (respawn) ou premier passage : on saute directement
      if (!s || Math.abs(p.b[0] - s[0]) > 220 || Math.abs(p.b[1] - s[1]) > 220) {
        s = p.b.slice();
        remote.pos.set(p.id, s);
      } else {
        for (let i = 0; i < s.length; i++) {
          s[i] = (i === 2 || i === 13)
            ? lerpAngle(s[i], p.b[i], k)
            : s[i] + (p.b[i] - s[i]) * k;
        }
      }
      return Object.assign({}, p, { b: s.slice() });
    });
    for (const id of remote.pos.keys()) if (!seen.has(id)) remote.pos.delete(id);

    return {
      players,
      weapons: snap.wp,
      bullets: snap.bu,
      booms: snap.bx,
      theme: snap.th,
      hazards: snap.hz,
      lava: snap.lv,
      balls: snap.sb,
      lasers: snap.ls,
      swings: snap.sw,
      crates: snap.cr,
      plats: snap.plats,
      round: snap.round,
      waiting: snap.players.length < 2,
    };
  }

  function updateScoreboard(players) {
    const rows = players.slice()
      .sort((a, b) => (b.s || 0) - (a.s || 0))
      .map((p) =>
        '<div class="lb-row' + (p.id === myId ? ' me' : '') + '">' +
        '<i style="background:' + p.c + '"></i>' + escapeHtml(p.n) +
        ' <span>' + (p.s || 0) + '</span></div>'
      ).join('');
    ui.scoreboard.innerHTML = '<h3>Manches gagnées</h3>' +
      (rows || '<div class="lb-row">—</div>') +
      (players.length < C.MAX_PLAYERS
        ? '<div class="lb-free">' + (C.MAX_PLAYERS - players.length) + ' place(s) libre(s)</div>'
        : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  // ---- panneau de réglage physique (touche T, chez l'hôte) ----
  // curseurs branchés en direct sur CFG.TUNE : on ajuste le "feel" en jouant,
  // puis on recopie les valeurs affichées dans js/config.js pour les graver
  const TUNE_DEFS = {
    LEAN: [0, 1, 0.01, 'Inclinaison course'],
    K_SOL: [1, 60, 1, 'Équilibre au sol'],
    K_AIR: [0, 30, 0.5, 'Équilibre en l\'air'],
    AMORTI: [0, 6, 0.1, 'Amortissement'],
    FOULEE: [0, 2, 0.05, 'Amplitude foulée'],
    G_JAMBES: [1, 40, 1, 'Vivacité jambes'],
    G_BRAS: [1, 40, 1, 'Vivacité bras bâton'],
    G_COU: [1, 30, 1, 'Tenue de la tête'],
    T_JAMBES: [0.5, 30, 0.5, 'Force jambes'],
    T_BRAS: [0.5, 30, 0.5, 'Force bras bâton'],
    T_BRAS2: [0, 15, 0.5, 'Force bras arrière'],
    T_COU: [0, 15, 0.5, 'Force du cou'],
  };
  let tunePanel = null;

  function toggleTune() {
    if (tunePanel) { tunePanel.remove(); tunePanel = null; return; }
    tunePanel = document.createElement('div');
    tunePanel.id = 'tunePanel';
    let html = '<h3>Réglage physique <small>(T pour fermer)</small></h3>';
    for (const key of Object.keys(TUNE_DEFS)) {
      const [min, max, step, label] = TUNE_DEFS[key];
      html += '<label>' + label +
        ' <output id="tv_' + key + '">' + C.TUNE[key] + '</output>' +
        '<input type="range" data-k="' + key + '" min="' + min +
        '" max="' + max + '" step="' + step + '" value="' + C.TUNE[key] + '">' +
        '</label>';
    }
    html += '<button id="tuneCopy">Copier les valeurs</button>';
    tunePanel.innerHTML = html;
    document.body.appendChild(tunePanel);
    tunePanel.addEventListener('input', (e) => {
      const k = e.target.dataset && e.target.dataset.k;
      if (!k) return;
      C.TUNE[k] = parseFloat(e.target.value);
      tunePanel.querySelector('#tv_' + k).value = C.TUNE[k];
    });
    tunePanel.querySelector('#tuneCopy').addEventListener('click', () => {
      navigator.clipboard.writeText(JSON.stringify(C.TUNE, null, 2));
    });
  }

  // T (réglage physique) et M (éditeur de map) : hôte seul dans la partie
  // uniquement — pas question de figer ou trafiquer une baston en cours
  function soloHost() {
    return mode === 'host' && world && world.players.size === 1;
  }
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 't' && running && !e.repeat && soloHost()) toggleTune();
    // M ouvre / ferme l'éditeur ; à la fermeture, une manche redémarre sur
    // la map éditée. On peut toujours FERMER l'éditeur, même si un copain
    // vient d'arriver entre-temps.
    if (e.key.toLowerCase() === 'm' && running && !e.repeat && window.Editor &&
        (Editor.active || soloHost())) {
      Editor.toggle(world, renderer, canvas, () => world.startRound());
    }
  });

  showMenu('');
  rafId = requestAnimationFrame(frame);
})();
