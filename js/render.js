// Rendu canvas : caméra fixe cadrant toute l'arène. Les bonshommes bâtons
// sont dessinés en reliant les points du pantin physique (torse, tête,
// mains, pieds) par des courbes souples — la physique fait l'animation.
(function (global) {
  const C = global.CFG;

  function createRenderer(canvas) {
    const ctx = canvas.getContext('2d');
    let scale = 1, ox = 0, oy = 0;

    function resize() {
      canvas.width = window.innerWidth * devicePixelRatio;
      canvas.height = window.innerHeight * devicePixelRatio;
      const cw = canvas.width, ch = canvas.height;
      scale = Math.min(cw / (C.WORLD.W + 80), ch / (C.WORLD.H + 60));
      ox = (cw - C.WORLD.W * scale) / 2;
      oy = (ch - C.WORLD.H * scale) / 2;
    }
    window.addEventListener('resize', resize);
    resize();

    // view: { players:[{id,n,c,x,y,vx,f,g,hp,d,a,ht}], plats:[[x,y,w,h,solid]],
    //         round:{ph,tm,w,n}, waiting:bool }
    function draw(view, myId, dt) {
      const cw = canvas.width, ch = canvas.height;

      // fond : dégradé nocturne + vignette
      const g = ctx.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, '#171b26');
      g.addColorStop(1, '#0e1017');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);

      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);

      drawPlats(view.plats);

      // armes libres (lancées, lâchées ou larguées du ciel)
      ctx.lineCap = 'round';
      for (const w of view.weapons || []) {
        drawWeaponShape(w[3] || 'baton', w[0], w[1], w[2]);
      }

      // balles traçantes — les projectiles explosifs sont des billes sombres
      for (const b of view.bullets || []) {
        if (b[4]) {
          ctx.fillStyle = '#3d4354';
          ctx.beginPath(); ctx.arc(b[0], b[1], 6, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#ffb15c';
          ctx.beginPath(); ctx.arc(b[0], b[1], 2.5, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.strokeStyle = '#ffe9a8';
          ctx.lineWidth = 3;
          line(b[0], b[1], b[2], b[3]);
        }
      }

      // explosions : boule de feu qui s'étend et s'estompe (q va de 1 à 0)
      for (const e of view.booms || []) {
        const [x, y, r, q] = e;
        const k = 1 - q;
        ctx.globalAlpha = Math.max(0, q);
        ctx.fillStyle = '#ffb15c';
        ctx.beginPath(); ctx.arc(x, y, r * (0.45 + 0.55 * k), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff3c4';
        ctx.beginPath(); ctx.arc(x, y, r * 0.4 * q, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }

      // les cadavres d'abord (sous les vivants), puis les vivants
      for (const p of view.players) if (p.d) drawStickman(p, p.id === myId);
      for (const p of view.players) if (!p.d) drawStickman(p, p.id === myId);

      ctx.restore();

      drawBanners(view, myId, cw, ch);
    }

    function drawPlats(plats) {
      for (const pl of plats) {
        const [x, y, w, h, solid] = pl;
        ctx.fillStyle = solid ? '#2c3446' : '#3a4258';
        roundRect(x, y, w, h, 8);
        ctx.fill();
        ctx.fillStyle = solid ? '#48546e' : '#5a6580';
        roundRect(x, y, w, 6, 3);
        ctx.fill();
      }
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawStickman(p, isMe) {
      const b = p.b;
      if (!b) return;   // cadavre parti dans le vide
      const [tx, ty, ta, hx, hy, a1x, a1y, a2x, a2y, l1x, l1y, l2x, l2y, ba] = b;
      const f = p.f || 1;
      // points d'attache sur la capsule du torse (repère tourné)
      const cos = Math.cos(ta), sin = Math.sin(ta);
      const at = (lx, ly) => [tx + lx * cos - ly * sin, ty + lx * sin + ly * cos];
      const [nkx, nky] = at(0, -18);   // cou
      const [shx, shy] = at(0, -15);   // épaules
      const [hpx, hpy] = at(0, 8);     // hanches

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = p.d ? 0.45 : 1;   // cadavres estompés

      const pass = (halo) => {
        // tronc + cou + tête
        bend(hpx, hpy, nkx, nky, -f * 2.5);
        line(nkx, nky, hx, hy);
        ctx.beginPath();
        ctx.arc(hx, hy, 8.5, 0, Math.PI * 2);
        if (halo) ctx.stroke(); else ctx.fill();
        // membres : courbes souples vers les points physiques
        bend(hpx, hpy, l1x, l1y, f * 4);
        bend(hpx, hpy, l2x, l2y, -f * 4);
        bend(shx, shy, a2x, a2y, -f * 3);
        bend(shx, shy, a1x, a1y, f * 3);
        // l'arme tenue prolonge le bras (même angle physique)
        if (p.w && !halo) {
          drawWeaponShape(p.w, a1x, a1y, ba, true);
          // flash de bouche au tir
          if (p.mu) {
            ctx.fillStyle = 'rgba(255,220,120,0.9)';
            ctx.beginPath();
            ctx.arc(a1x + Math.cos(ba) * 30, a1y + Math.sin(ba) * 30, 7, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      };
      // bulle de bouclier (clic droit maintenu)
      if (p.bl && !p.d) {
        ctx.beginPath();
        ctx.arc(tx, ty - 5, 46, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(92,225,230,0.12)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(92,225,230,0.7)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      // halo quand on vient d'être touché (doré si coup à la tête)
      if (p.ht) {
        ctx.strokeStyle = p.ht === 2 ? 'rgba(255,209,102,0.95)' : 'rgba(255,255,255,0.9)';
        ctx.lineWidth = p.ht === 2 ? 11 : 9;
        pass(true);
      }
      ctx.strokeStyle = p.c;
      ctx.fillStyle = p.c;
      ctx.lineWidth = 5;
      pass(false);

      // barre de vie + pseudo (pas sur les cadavres)
      if (!p.d) {
        const topY = Math.min(hy, ty - 20);
        const bw = 46, bx2 = tx - bw / 2, by = topY - 26;
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(bx2 - 1, by - 1, bw + 2, 7);
        const ratio = Math.max(0, p.hp) / C.HP;
        ctx.fillStyle = ratio > 0.5 ? '#6ee7a0' : ratio > 0.25 ? '#ffd166' : '#ff5c5c';
        ctx.fillRect(bx2, by, bw * ratio, 5);
        // jauge de bouclier (cyan) sous les PV
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(bx2 - 1, by + 7, bw + 2, 5);
        ctx.fillStyle = '#5ce1e6';
        ctx.fillRect(bx2, by + 8, bw * Math.max(0, p.sh || 0) / C.SHIELD, 3);
        ctx.fillStyle = isMe ? '#ffffff' : 'rgba(255,255,255,0.75)';
        ctx.font = (isMe ? '700 ' : '') + '15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        const gun = p.w && C.WEAPONS[p.w] && C.WEAPONS[p.w].ammo;
        ctx.fillText(gun ? p.n + ' · ' + p.mn : p.n, tx, by - 7);
      }
      ctx.globalAlpha = 1;
    }

    function line(x1, y1, x2, y2) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // dessine une arme à (x,y) orientée selon ang ; held = tenue en main
    // (l'origine est alors la main, sinon le centre de l'objet)
    function drawWeaponShape(type, x, y, ang, held) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      if (!held) ctx.translate(-16, 0);
      ctx.lineCap = 'round';
      switch (type) {
        case 'epee':
          ctx.strokeStyle = '#cfd6e4'; ctx.lineWidth = 5;
          line(0, 0, 50, 0);
          ctx.strokeStyle = '#8a6b3f'; ctx.lineWidth = 4;
          line(6, -7, 6, 7);
          break;
        case 'lance':
          ctx.strokeStyle = '#a5814e'; ctx.lineWidth = 4;
          line(-12, 0, 62, 0);
          ctx.strokeStyle = '#cfd6e4'; ctx.lineWidth = 5;
          line(62, 0, 74, 0);
          break;
        case 'pistolet':
          ctx.strokeStyle = '#3d4354'; ctx.lineWidth = 7;
          line(0, 0, 16, 0);
          line(2, 2, 2, 9);
          break;
        case 'uzi':
          ctx.strokeStyle = '#3d4354'; ctx.lineWidth = 8;
          line(-2, 0, 20, 0);
          line(4, 3, 4, 12);
          break;
        case 'pompe':
          ctx.strokeStyle = '#5a4632'; ctx.lineWidth = 7;
          line(-8, 0, 8, 0);
          ctx.strokeStyle = '#3d4354'; ctx.lineWidth = 5;
          line(8, 0, 32, 0);
          break;
        case 'revolver':
          ctx.strokeStyle = '#8b93a8'; ctx.lineWidth = 6;
          line(0, 0, 20, 0);
          ctx.strokeStyle = '#5a4632'; ctx.lineWidth = 5;
          line(1, 2, 1, 10);
          break;
        case 'ak47':
          ctx.strokeStyle = '#5a4632'; ctx.lineWidth = 6;
          line(-12, 0, 6, 0);
          ctx.strokeStyle = '#3d4354'; ctx.lineWidth = 5;
          line(6, 0, 36, 0);
          line(10, 3, 8, 12);   // chargeur courbe
          break;
        case 'minigun':
          ctx.strokeStyle = '#2f3542'; ctx.lineWidth = 12;
          line(-10, 0, 10, 0);
          ctx.strokeStyle = '#565f75'; ctx.lineWidth = 3;
          line(10, -4, 34, -4); line(10, 0, 36, 0); line(10, 4, 34, 4);
          break;
        case 'sabre':
          ctx.strokeStyle = '#3d4354'; ctx.lineWidth = 6;
          line(-2, 0, 10, 0);
          ctx.strokeStyle = 'rgba(120,220,255,0.35)'; ctx.lineWidth = 10;
          line(10, 0, 58, 0);
          ctx.strokeStyle = '#8ce9ff'; ctx.lineWidth = 5;
          line(10, 0, 58, 0);
          break;
        case 'grenades':
          ctx.strokeStyle = '#4c6b4f'; ctx.lineWidth = 10;
          line(0, 0, 22, 0);
          ctx.strokeStyle = '#3d4354'; ctx.lineWidth = 4;
          line(4, 3, 4, 11);
          break;
        case 'rpg':
          ctx.strokeStyle = '#4f5568'; ctx.lineWidth = 9;
          line(-14, 0, 26, 0);
          ctx.fillStyle = '#c0392b';
          ctx.beginPath(); ctx.arc(30, 0, 6, 0, Math.PI * 2); ctx.fill();
          break;
        case 'sniper':
          ctx.strokeStyle = '#2f3542'; ctx.lineWidth = 5;
          line(-10, 0, 42, 0);
          ctx.fillStyle = '#5ce1e6';
          ctx.beginPath(); ctx.arc(8, -5, 3, 0, Math.PI * 2); ctx.fill();
          break;
        default:   // bâton
          ctx.strokeStyle = '#b98a4e'; ctx.lineWidth = 6;
          line(0, 0, 44, 0);
      }
      ctx.restore();
    }

    // trait courbé : segment avec un ventre perpendiculaire (effet caoutchouc)
    function bend(x1, y1, x2, y2, b) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(mx - (dy / len) * b, my + (dx / len) * b, x2, y2);
      ctx.stroke();
    }

    function drawBanners(view, myId, cw, ch) {
      ctx.textAlign = 'center';
      const r = view.round;

      if (view.waiting) {
        banner(cw, ch, 'En attente des copains…',
          'Partagez le lien d\'invitation (en haut à gauche) — la partie démarre à 2 joueurs.');
        return;
      }
      if (r && r.ph === 'over') {
        const title = r.w ? r.w + ' remporte la manche !' : 'Égalité — tout le monde est tombé !';
        banner(cw, ch, title, 'Manche suivante dans ' + Math.ceil(r.tm / 1000) + ' s');
        return;
      }
      // mort en cours de manche : on spectate
      const me = view.players.find((p) => p.id === myId);
      if (me && me.d) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '700 ' + Math.round(26 * devicePixelRatio) + 'px system-ui, sans-serif';
        ctx.fillText('💀 Éliminé ! La manche continue sans vous…', cw / 2, ch * 0.14);
      }
    }

    function banner(cw, ch, title, sub) {
      ctx.fillStyle = 'rgba(10,12,18,0.55)';
      ctx.fillRect(0, ch * 0.36, cw, ch * 0.2);
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 ' + Math.round(40 * devicePixelRatio) + 'px system-ui, sans-serif';
      ctx.fillText(title, cw / 2, ch * 0.45);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = Math.round(19 * devicePixelRatio) + 'px system-ui, sans-serif';
      ctx.fillText(sub, cw / 2, ch * 0.51);
    }

    // écran (pixels CSS) -> coordonnées monde, pour viser à la souris
    function worldFromScreen(mx, my) {
      return {
        x: (mx * devicePixelRatio - ox) / scale,
        y: (my * devicePixelRatio - oy) / scale,
      };
    }

    return { draw, resize, worldFromScreen };
  }

  global.Render = { createRenderer };
})(window);
