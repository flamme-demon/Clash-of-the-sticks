// Éditeur de maps (hôte uniquement, touche M) : la partie se fige, on place
// blocs, pièges et spawns à la souris. Chaque changement est appliqué en
// direct au monde — l'hôte et les invités voient la map évoluer. En quittant
// l'éditeur, une manche redémarre sur la map. Export/import par code compact
// (JSON + base64), sauvegarde dans le navigateur (localStorage).
(function (global) {
  const C = global.CFG;
  const SNAP = 10;                       // grille magnétique (px monde)
  const LS_KEY = 'baton-maps';

  // outils : rect = tracé à la souris ; point = clic ; line = deux clics
  const TOOLS = [
    { id: 'move', ic: '✋', nom: 'Déplacer / supprimer (clic droit)' },
    { id: 'bloc', ic: '⬜', nom: 'Bloc', kind: 'rect' },
    { id: 'ice', ic: '🧊', nom: 'Glace (glisse, casse sous les balles)', kind: 'rect' },
    { id: 'blink', ic: '👻', nom: 'Bloc clignotant', kind: 'rect' },
    { id: 'crumble', ic: '🍪', nom: 'Bloc friable (cède sous les pas)', kind: 'rect' },
    { id: 'spikes', ic: '🔺', nom: 'Pics', kind: 'rect' },
    { id: 'ball', ic: '⛓️', nom: 'Boule piquante (clic = ancre)', kind: 'point' },
    { id: 'laser', ic: '🔴', nom: 'Laser (deux clics : début, fin)', kind: 'line' },
    { id: 'swing', ic: '🪵', nom: 'Balançoire (clic = ancre)', kind: 'point' },
    { id: 'crate', ic: '📦', nom: 'Caisse', kind: 'point' },
    { id: 'spawn', ic: '🚩', nom: 'Point d\'apparition', kind: 'point' },
  ];

  const E = {
    active: false,
    testing: false,    // mode essai : la partie tourne, l'édition est en pause
    def: null,
    world: null,
    renderer: null,
    canvas: null,
    tool: 'move',
    drag: null,        // tracé de rect en cours {x0,y0,x1,y1}
    lineStart: null,   // premier clic d'un laser
    moving: null,      // {obj, list, dx, dy} objet en cours de déplacement
    panel: null,
    onExit: null,
  };

  function snap(v) { return Math.round(v / SNAP) * SNAP; }

  function emptyDef() {
    const { W, H } = C.WORLD;
    return {
      v: 1, theme: 0,
      plats: [{ x: W / 2 - 400, y: H - 130, w: 800, h: 52 }],
      spikes: [], lava: null, balls: [], lasers: [], swings: [], crates: [],
      spawns: [],
    };
  }

  // capture la carte actuellement en jeu : on peut retoucher une carte
  // aléatoire qu'on aime bien
  function captureDef(world) {
    return {
      v: 1, theme: world.theme,
      plats: world.plats.map((q) => ({
        x: q.x, y: q.y, w: q.w, h: q.h,
        mode: q.mode || undefined, ice: q.ice || undefined,
      })),
      spikes: world.hazards.map((h) => ({ x: h.x, y: h.y, w: h.w })),
      lava: world.lava ? { y: world.lava.y, rise: world.lava.rise ? 1 : 0 } : null,
      balls: world.balls.map((b) => ({ ax: b.ax, ay: b.ay, L: b.L, amp: b.amp })),
      lasers: world.lasers.map((l) => ({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 })),
      swings: world.swings.map((s) => ({ ax: s.ax, ay: s.ay, L: s.L, amp: s.amp, w: s.w })),
      crates: world.crates.map((c) => {
        const q = c.body.getPosition();
        return { x: Math.round(q.x * C.SCALE), y: Math.round(q.y * C.SCALE) };
      }),
      spawns: world.spawns.map((s) => ({ x: s.x, y: s.y })),
    };
  }

  // applique la map au monde en direct (le monde est figé pendant l'édition)
  function apply() {
    E.world.customMap = JSON.parse(JSON.stringify(E.def));
    E.world.newMap();
  }

  function encode(def) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(def))));
  }
  function decode(code) {
    return JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
  }

  function savedMaps() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch (_) { return {}; }
  }

  // ---------- interactions souris ----------
  function worldPos(e) {
    const w = E.renderer.worldFromScreen(e.clientX, e.clientY);
    return { x: snap(w.x), y: snap(w.y) };
  }

  // recherche de l'objet le plus proche (pour déplacer / supprimer)
  function hitTest(x, y) {
    const d = E.def;
    const near = (px, py, r) => Math.hypot(px - x, py - y) < r;
    for (const c of d.crates) if (near(c.x, c.y, 34)) return { obj: c, list: d.crates, px: 'x', py: 'y' };
    for (const b of d.balls) {
      if (near(b.ax, b.ay, 30)) return { obj: b, list: d.balls, px: 'ax', py: 'ay' };
      if (near(b.ax, b.ay + b.L, 44)) return { obj: b, list: d.balls, px: 'ax', py: 'ay', dy: -b.L };
    }
    for (const s of d.swings) if (near(s.ax, s.ay, 30) || near(s.ax, s.ay + s.L, 40)) {
      return { obj: s, list: d.swings, px: 'ax', py: 'ay' };
    }
    for (const s of d.spawns) if (near(s.x, s.y - 25, 35)) return { obj: s, list: d.spawns, px: 'x', py: 'y' };
    for (const l of d.lasers) {
      if (near(l.x1, l.y1, 25) || near(l.x2, l.y2, 25)) return { obj: l, list: d.lasers, laser: true };
    }
    for (const s of d.spikes) {
      if (x > s.x && x < s.x + s.w && y > s.y - 12 && y < s.y + 20) {
        return { obj: s, list: d.spikes, px: 'x', py: 'y' };
      }
    }
    for (const q of d.plats) {
      if (x > q.x && x < q.x + q.w && y > q.y && y < q.y + q.h) {
        return { obj: q, list: d.plats, px: 'x', py: 'y' };
      }
    }
    return null;
  }

  function onDown(e) {
    if (!E.active || E.testing) return;
    e.preventDefault();
    const { x, y } = worldPos(e);
    const t = TOOLS.find((t2) => t2.id === E.tool);

    if (e.button === 2 || E.tool === 'erase') {   // clic droit : supprimer
      const hit = hitTest(x, y);
      if (hit) {
        hit.list.splice(hit.list.indexOf(hit.obj), 1);
        apply();
      }
      return;
    }
    if (E.tool === 'move') {
      const hit = hitTest(x, y);
      if (hit && !hit.laser) {
        E.moving = { hit, ox: hit.obj[hit.px] - x, oy: hit.obj[hit.py] - y };
      } else if (hit && hit.laser) {
        // déplacer un laser : on attrape l'extrémité la plus proche
        const l = hit.obj;
        const d1 = Math.hypot(l.x1 - x, l.y1 - y), d2 = Math.hypot(l.x2 - x, l.y2 - y);
        E.moving = { laser: l, end: d1 < d2 ? 1 : 2 };
      }
      return;
    }
    if (t.kind === 'rect') { E.drag = { x0: x, y0: y, x1: x, y1: y }; return; }
    if (t.kind === 'line') {
      if (!E.lineStart) { E.lineStart = { x, y }; return; }
      let { x: x1, y: y1 } = E.lineStart;
      // aligne le rayon s'il est presque droit
      if (Math.abs(x - x1) < 40) x1 = x;
      else if (Math.abs(y - y1) < 40) y1 = y;
      E.def.lasers.push({ x1, y1, x2: x, y2: y });
      E.lineStart = null;
      apply();
      return;
    }
    // outils "point"
    if (E.tool === 'ball') E.def.balls.push({ ax: x, ay: y, L: 260, amp: 0.8 });
    else if (E.tool === 'swing') E.def.swings.push({ ax: x, ay: y, L: 280, amp: 0.45, w: 150 });
    else if (E.tool === 'crate') E.def.crates.push({ x, y });
    else if (E.tool === 'spawn') E.def.spawns.push({ x, y });
    apply();
  }

  function onMove(e) {
    if (!E.active || E.testing) return;
    const { x, y } = worldPos(e);
    if (E.drag) { E.drag.x1 = x; E.drag.y1 = y; }
    else if (E.moving) {
      if (E.moving.laser) {
        const l = E.moving.laser;
        if (E.moving.end === 1) { l.x1 = x; l.y1 = y; } else { l.x2 = x; l.y2 = y; }
      } else {
        const { hit, ox, oy } = E.moving;
        hit.obj[hit.px] = x + ox;
        hit.obj[hit.py] = y + oy;
      }
    }
  }

  function onUp(e) {
    if (!E.active || E.testing) return;
    if (E.moving) { E.moving = null; apply(); return; }
    if (!E.drag) return;
    const d = E.drag; E.drag = null;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 30) return;   // tracé raté
    if (E.tool === 'spikes') E.def.spikes.push({ x, y, w });
    else {
      const q = { x, y, w, h: Math.max(30, h) };
      if (E.tool === 'ice') q.ice = 1;
      else if (E.tool === 'blink') q.mode = 'blink';
      else if (E.tool === 'crumble') q.mode = 'crumble';
      E.def.plats.push(q);
    }
    apply();
  }

  // ---------- superposition dessinée après le rendu normal ----------
  function drawOverlay() {
    if (!E.active || E.testing) return;
    const { scale, ox, oy, ctx } = E.renderer.getTransform();
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    // bord de l'arène
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 10]);
    ctx.strokeRect(0, 0, C.WORLD.W, C.WORLD.H);
    ctx.setLineDash([]);
    // spawns
    for (const s of E.def.spawns) {
      ctx.fillStyle = 'rgba(110,231,160,0.9)';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x, s.y - 46);
      ctx.lineTo(s.x + 26, s.y - 38);
      ctx.lineTo(s.x, s.y - 30);
      ctx.fill();
      ctx.strokeStyle = 'rgba(110,231,160,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y - 46); ctx.stroke();
    }
    // tracé de rectangle en cours
    if (E.drag) {
      const x = Math.min(E.drag.x0, E.drag.x1), y = Math.min(E.drag.y0, E.drag.y1);
      ctx.strokeStyle = '#ffb454';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, Math.abs(E.drag.x1 - E.drag.x0), Math.abs(E.drag.y1 - E.drag.y0));
    }
    // premier point d'un laser
    if (E.lineStart) {
      ctx.fillStyle = '#ff4d4d';
      ctx.beginPath(); ctx.arc(E.lineStart.x, E.lineStart.y, 8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ---------- panneau ----------
  function buildPanel() {
    const p = document.createElement('div');
    p.id = 'editorPanel';
    let html = '<h3>Éditeur de map <small>(M pour fermer et jouer)</small></h3><div class="tools">';
    for (const t of TOOLS) {
      html += '<button class="tool" data-t="' + t.id + '" title="' + t.nom + '">' + t.ic + '</button>';
    }
    html += '</div>' +
      '<button id="edPlay" class="play">▶ Tester la map</button>' +
      '<div class="row">' +
      '<button id="edTheme">Thème</button>' +
      '<button id="edLava">Lave : non</button>' +
      '</div><div class="row">' +
      '<button id="edExport">Exporter</button>' +
      '<button id="edImport">Importer</button>' +
      '</div><div class="row">' +
      '<button id="edSave">Sauver</button>' +
      '<select id="edLoad"><option value="">Charger…</option></select>' +
      '</div><div class="row">' +
      '<button id="edClear">Vider</button>' +
      '<button id="edRandom">Aléatoire</button>' +
      '</div><p id="edMsg"></p>';
    p.innerHTML = html;
    document.body.appendChild(p);

    const msg = (s) => { p.querySelector('#edMsg').textContent = s; };
    const refreshLoad = () => {
      const sel = p.querySelector('#edLoad');
      sel.innerHTML = '<option value="">Charger…</option>' +
        Object.keys(savedMaps()).map((n) =>
          '<option>' + n.replace(/[&<>"]/g, '') + '</option>').join('');
    };
    refreshLoad();

    p.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.t) {
        E.tool = b.dataset.t;
        E.lineStart = null;
        for (const el of p.querySelectorAll('.tool')) el.classList.toggle('sel', el === b);
        return;
      }
      switch (b.id) {
        case 'edPlay':
          // essai de la map : la partie tourne, le panneau se réduit ;
          // au retour on refige tout et on reprend l'édition
          E.testing = !E.testing;
          E.panel.classList.toggle('testing', E.testing);
          b.textContent = E.testing ? '⏹ Reprendre l\'édition' : '▶ Tester la map';
          E.drag = null; E.lineStart = null; E.moving = null;
          if (E.testing) { apply(); E.world.startRound(); }
          break;
        case 'edTheme':
          E.def.theme = (E.def.theme + 1) % C.THEMES.length;
          msg('Thème : ' + C.THEMES[E.def.theme].nom);
          apply();
          break;
        case 'edLava': {
          // cycle : pas de lave -> lave -> lave montante
          const l = E.def.lava;
          E.def.lava = !l ? { y: C.WORLD.H - 20, rise: 0 }
            : (!l.rise ? { y: C.WORLD.H - 20, rise: 1 } : null);
          b.textContent = 'Lave : ' + (!E.def.lava ? 'non' : (E.def.lava.rise ? 'montante' : 'oui'));
          apply();
          break;
        }
        case 'edExport':
          navigator.clipboard.writeText(encode(E.def));
          msg('Code de la map copié — collez-le à un copain !');
          break;
        case 'edImport': {
          const code = prompt('Collez un code de map :');
          if (!code) break;
          try { E.def = decode(code); apply(); msg('Map importée.'); }
          catch (_) { msg('Code invalide.'); }
          break;
        }
        case 'edSave': {
          const n = prompt('Nom de la map :');
          if (!n) break;
          const maps = savedMaps();
          maps[n.slice(0, 24)] = E.def;
          localStorage.setItem(LS_KEY, JSON.stringify(maps));
          refreshLoad();
          msg('« ' + n + ' » sauvée dans ce navigateur.');
          break;
        }
        case 'edClear':
          E.def = emptyDef();
          apply();
          break;
        case 'edRandom':
          E.world.customMap = null;
          E.world.newMap();
          E.def = captureDef(E.world);
          msg('Nouvelle carte aléatoire (modifiable).');
          break;
      }
    });
    p.querySelector('#edLoad').addEventListener('change', (ev) => {
      const def = savedMaps()[ev.target.value];
      if (def) { E.def = JSON.parse(JSON.stringify(def)); apply(); msg('Map chargée.'); }
      ev.target.value = '';
    });
    return p;
  }

  // ---------- entrée / sortie du mode ----------
  function toggle(world, renderer, canvas, onExit) {
    if (E.active) {
      E.active = false;
      E.testing = false;
      E.panel.remove(); E.panel = null;
      E.drag = null; E.lineStart = null; E.moving = null;
      canvas.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      if (E.onExit) E.onExit();
      return;
    }
    E.active = true;
    E.world = world;
    E.renderer = renderer;
    E.canvas = canvas;
    E.onExit = onExit;
    E.tool = 'move';
    // point de départ : la map custom en cours, sinon la carte affichée
    E.def = world.customMap ? JSON.parse(JSON.stringify(world.customMap))
      : captureDef(world);
    E.panel = buildPanel();
    E.panel.querySelector('[data-t="move"]').classList.add('sel');
    E.panel.querySelector('#edLava').textContent =
      'Lave : ' + (!E.def.lava ? 'non' : (E.def.lava.rise ? 'montante' : 'oui'));
    apply();
    // capture=true : l'éditeur passe avant les contrôles du jeu
    canvas.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }

  global.Editor = {
    toggle, drawOverlay,
    get active() { return E.active; },
    get testing() { return E.testing; },
  };
})(window);
