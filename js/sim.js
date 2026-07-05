// Simulation : ragdolls articulés Planck.js (portage JS de Box2D), combat au
// bâton, génération des arènes et gestion des manches. Ne tourne que chez
// l'hôte ; les invités reçoivent des snapshots et n'exécutent rien de tout ça.
//
// Chaque joueur est un pantin physique : une capsule de torse tenue debout
// par un ressort angulaire (d'où le côté chewing-gum), une tête, deux bras
// et deux jambes pendus par des joints motorisés, et le bâton soudé à la
// main. À la mort, tous les moteurs se coupent : le corps s'effondre et le
// cadavre reste dans l'arène jusqu'à la manche suivante.
(function (global) {
  const C = global.CFG;
  const pl = global.planck ||
    (typeof require === 'function' ? require('./vendor/planck.min.js') : null);
  const S = C.SCALE;                              // pixels par mètre physique
  const V = (x, y) => new pl.Vec2(x / S, y / S);  // px -> monde physique
  const CAT = { WORLD: 1, BODY: 2, LIMB: 4 };

  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function norm(a) {
    return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  }

  class World {
    constructor() {
      this.players = new Map();   // id -> joueur
      this.plats = [];            // {x,y,w,h,solid} — x,y = coin haut-gauche
      this.platBodies = [];       // corps statiques Planck correspondants
      this.spawns = [];           // {x,y} — pieds posés sur une plateforme
      this.round = { n: 1, phase: 'play', timer: 0, winner: '' };
      this.weapons = new Map();   // bâtons libres (lancés / lâchés) -> corps Planck
      this._wid = 0;
      this._usedColors = new Set();

      this.pw = new pl.World({ gravity: new pl.Vec2(0, C.GRAVITY / S) });
      // plateformes fines traversables : on annule le contact quand le corps
      // arrive par en dessous ou est encore en train de monter
      this.pw.on('pre-solve', (contact) => {
        const fA = contact.getFixtureA(), fB = contact.getFixtureB();
        const uA = fA.getUserData(), uB = fB.getUserData();
        const ow = uA && uA.oneway ? uA : (uB && uB.oneway ? uB : null);
        if (!ow) return;
        const body = (uA && uA.oneway ? fB : fA).getBody();
        const bud = body.getUserData();
        const y = body.getPosition().y * S + ((bud && bud.foot) || 0);
        if (y > ow.top + 6 || body.getLinearVelocity().y < -1) {
          contact.setEnabled(false);
        }
      });
      this.newMap();
    }

    // ---------- joueurs ----------
    addPlayer(id, name) {
      const color = C.COLORS.find((c) => !this._usedColors.has(c)) || C.COLORS[0];
      this._usedColors.add(color);
      const p = {
        id, name, color,
        x: 0, y: 0,               // pieds (dérivés du torse à chaque tick)
        facing: 1, onGround: false, jumps: 0, coyote: 0,
        aim: 0,                   // angle de visée (souris), radians, 0 = droite
        hp: C.HP, dead: false, score: 0,
        sh: C.SHIELD, shT: 9999,  // bouclier + temps depuis le dernier dégât
        atkT: -1,                 // ms depuis le début du coup, -1 = inactif
        cd: 0,                    // recharge de l'attaque
        ht: 0,                    // flash "touché"
        htCrit: false,            // le dernier coup reçu était un coup à la tête
        stagger: 0,               // équilibre affaibli juste après un coup reçu
        phase: 0,                 // phase de la démarche
        hitIds: new Set(),        // déjà touchés pendant ce coup
        weapon: true,             // tient son bâton (sinon poings et pieds)
        combo: 0,                 // alterne poing / pied à mains nues
        ragdoll: null,
        input: { left: false, right: false, jump: false, attack: false, throw: false },
      };
      this.players.set(id, p);
      this.spawn(p);
      return p;
    }

    removePlayer(id) {
      const p = this.players.get(id);
      if (!p) return;
      this._destroyRagdoll(p);
      this._usedColors.delete(p.color);
      this.players.delete(id);
    }

    setInput(id, msg) {
      const p = this.players.get(id);
      if (!p) return;
      p.input.left = !!msg.l;
      p.input.right = !!msg.r;
      if (typeof msg.m === 'number' && isFinite(msg.m)) p.aim = msg.m;
      // sauts et coups sont des impulsions : on les accumule jusqu'au
      // prochain tick pour ne jamais en perdre entre deux envois réseau
      if (msg.j) p.input.jump = true;
      if (msg.a) p.input.attack = true;
      if (msg.tr) p.input.throw = true;
    }

    spawn(p) {
      const s = this.spawns[Math.floor(Math.random() * this.spawns.length)];
      this._destroyRagdoll(p);
      p.ragdoll = this._buildRagdoll(s.x, s.y);
      p.x = s.x; p.y = s.y;
      p.hp = C.HP; p.dead = false;
      p.sh = C.SHIELD; p.shT = 9999;
      p.atkT = -1; p.cd = 0; p.ht = 0; p.htCrit = false;
      p.stagger = 0; p.phase = 0; p.weapon = true;
      p.jumps = 0; p.onGround = true;
    }

    // repositionne tout le pantin d'un bloc (débogage / tests)
    teleport(id, x, y) {
      const p = this.players.get(id);
      if (!p || !p.ragdoll) return;
      const t = p.ragdoll.torso.getPosition();
      const dx = x / S - t.x, dy = (y - 20) / S - t.y;
      for (const b of p.ragdoll.bodies) {
        const q = b.getPosition();
        b.setTransform(new pl.Vec2(q.x + dx, q.y + dy), b.getAngle());
        b.setLinearVelocity(new pl.Vec2(0, 0));
        b.setAngularVelocity(0);
      }
      p.x = x; p.y = y;
    }

    // ---------- pantin ----------
    _buildRagdoll(x, y) {
      // y = pieds. Capsule de torse : épaules (y-40) -> pieds (y), seule à
      // toucher le décor de son vivant ; les membres sont décoratifs mais
      // physiques (ils pendent, ballottent, et s'activent à la mort).
      const pw = this.pw;
      const r = {};
      r.torso = pw.createBody({
        type: 'dynamic', position: V(x, y - 20), angularDamping: 1,
      });
      r.torso.createFixture({
        shape: new pl.Box(13 / S, 20 / S), density: 1, friction: 0.05,
        filterCategoryBits: CAT.BODY, filterMaskBits: CAT.WORLD,
      });
      r.torso.setUserData({ foot: 20 });

      r.head = pw.createBody({ type: 'dynamic', position: V(x, y - 49) });
      r.head.createFixture({
        shape: new pl.Circle(9 / S), density: 0.6, friction: 0.3,
        filterCategoryBits: CAT.LIMB, filterMaskBits: 0,
      });
      r.neck = pw.createJoint(new pl.RevoluteJoint({
        lowerAngle: -0.5, upperAngle: 0.5, enableLimit: true,
        enableMotor: true, maxMotorTorque: 4,
      }, r.torso, r.head, V(x, y - 40)));

      // membre : boîte fine pivotée à son extrémité, pendant vers le bas
      const limb = (px, py, len) => {
        const b = pw.createBody({
          type: 'dynamic', position: V(px, py),
          angle: Math.PI / 2, angularDamping: 0.8,
        });
        b.createFixture({
          shape: new pl.Box(len / 2 / S, 2 / S, new pl.Vec2(len / 2 / S, 0)),
          density: 0.35, friction: 0.4,
          filterCategoryBits: CAT.LIMB, filterMaskBits: 0,
        });
        return b;
      };
      const joint = (bodyB, px, py, torque) => pw.createJoint(new pl.RevoluteJoint({
        enableMotor: true, maxMotorTorque: torque,
      }, r.torso, bodyB, V(px, py)));

      // bras 0 = bras d'attaque (le bâton, purement visuel, suit son angle)
      r.arms = [limb(x, y - 38, 18), limb(x, y - 38, 18)];
      r.shoulders = [joint(r.arms[0], x, y - 38, 12), joint(r.arms[1], x, y - 38, 3)];
      r.legs = [limb(x, y - 26, 26), limb(x, y - 26, 26)];
      r.hips = [joint(r.legs[0], x, y - 26, 9), joint(r.legs[1], x, y - 26, 9)];

      r.bodies = [r.torso, r.head, ...r.arms, ...r.legs];
      r.joints = [r.neck, ...r.shoulders, ...r.hips];
      return r;
    }

    _destroyRagdoll(p) {
      if (!p.ragdoll) return;
      for (const b of p.ragdoll.bodies) this.pw.destroyBody(b);
      p.ragdoll = null;
    }

    // le bouclier absorbe d'abord, le reste entame les PV
    _damage(e, dmg) {
      e.shT = 0;
      const ab = Math.min(e.sh, dmg);
      e.sh -= ab;
      e.hp -= dmg - ab;
    }

    _die(p) {
      p.dead = true;
      // on lâche son bâton en mourant
      if (p.weapon && p.ragdoll) {
        const v = p.ragdoll.torso.getLinearVelocity();
        this._spawnWeapon(p.x, p.y - 40, v.x * S * 0.5, v.y * S * 0.5 - 120,
          rand(-8, 8), null);
        p.weapon = false;
      }
      const r = p.ragdoll;
      if (!r) return;
      // pantin de chiffon : moteurs coupés, membres qui heurtent le décor
      for (const j of r.joints) {
        j.enableMotor(false);
        j.setMotorSpeed(0);
      }
      for (const b of r.bodies) {
        for (let f = b.getFixtureList(); f; f = f.getNext()) {
          f.setFilterData({ groupIndex: 0, categoryBits: CAT.LIMB, maskBits: CAT.WORLD });
        }
      }
    }

    // ---------- armes libres ----------
    _spawnWeapon(x, y, vx, vy, spin, thrower) {
      const b = this.pw.createBody({
        type: 'dynamic', position: V(x, y), angle: Math.atan2(vy, vx),
        bullet: true, angularDamping: 0.05,
      });
      // en vol rapide : trajectoire tendue (peu de gravité), il file droit
      // vers la cible ; la gravité normale revient une fois ralenti
      if (Math.hypot(vx, vy) > 500) b.setGravityScale(0.3);
      // collision : petite boule au centre (le bâton visuel tournoie autour) —
      // sinon les extrémités raclent le sol en plein vol et le font ricocher
      b.createFixture({
        shape: new pl.Circle(6 / S), density: 2,
        friction: 0.6, restitution: 0.25,
        filterCategoryBits: CAT.LIMB, filterMaskBits: CAT.WORLD,
      });
      b.setLinearVelocity(new pl.Vec2(vx / S, vy / S));
      b.setAngularVelocity(spin);
      this.weapons.set(++this._wid, { body: b, thrower, t: 0 });
    }

    _tickWeapons(dtMs) {
      for (const [id, w] of this.weapons) {
        w.t += dtMs;
        const q = w.body.getPosition();
        const wx = q.x * S, wy = q.y * S;
        // parti dans le vide
        if (wy > C.WORLD.H + C.KILL_Y * 2 ||
            wx < -C.KILL_X * 2 || wx > C.WORLD.W + C.KILL_X * 2) {
          this.pw.destroyBody(w.body);
          this.weapons.delete(id);
          continue;
        }
        const v = w.body.getLinearVelocity();
        const sp = Math.hypot(v.x, v.y) * S;
        if (sp < 500) {
          w.body.setGravityScale(1);      // fin du vol tendu
          w.body.setAngularDamping(3);    // l'hélice s'arrête de rouler
        }
        if (sp > 350) {
          // projectile : blesse ce qu'il croise (une victime par lancer)
          for (const e of this.players.values()) {
            if (e.dead || !e.ragdoll) continue;
            if (e.id === w.thrower && w.t < 350) continue; // pas le lanceur au départ
            if (Math.hypot(wx - e.x, wy - (e.y - C.PLAYER.H * 0.5)) > 40) continue;
            this._damage(e, C.THROW_DMG);
            e.ht = C.HIT_FLASH_MS * 1.8;
            e.htCrit = false;
            e.stagger = 350;
            const scale = 0.7 + ((C.HP - Math.max(0, e.hp)) / C.HP) * 1.4;
            const nx = v.x / (sp / S), ny = v.y / (sp / S);
            e.ragdoll.torso.setLinearVelocity(new pl.Vec2(
              nx * C.KNOCK * scale / S,
              (ny * C.KNOCK * scale * 0.85 - 150) / S
            ));
            e.ragdoll.torso.setAngularVelocity((nx > 0 ? 1 : -1) * 5 * scale);
            if (e.hp <= 0) { e.hp = 0; this._die(e); }
            w.thrower = null;
            w.body.setLinearVelocity(new pl.Vec2(v.x * 0.25, v.y * 0.25));
            break;
          }
        } else if (w.t > 400) {
          // plus dangereux : ramassage par un joueur désarmé qui passe dessus
          for (const e of this.players.values()) {
            if (e.dead || e.weapon || !e.ragdoll) continue;
            if (Math.hypot(wx - e.x, wy - (e.y - 25)) < 45) {
              e.weapon = true;
              this.pw.destroyBody(w.body);
              this.weapons.delete(id);
              break;
            }
          }
        }
      }
    }

    // ---------- arène ----------
    newMap() {
      const { W, H } = C.WORLD;
      for (const b of this.platBodies) this.pw.destroyBody(b);
      this.platBodies = [];
      this.plats = [];
      // sol : 2-3 gros blocs séparés par des trous mortels
      const gy = H - 130;
      let x = rand(30, 110);
      while (x < W - 260) {
        const w = Math.min(rand(340, 680), W - 30 - x);
        if (w < 200) break;
        this.plats.push({ x, y: gy, w, h: 52, solid: true });
        x += w + rand(110, 180);
      }
      // plateformes flottantes (traversables par en dessous), espacées pour
      // être atteignables d'un saut simple ou double depuis la précédente
      const rows = [gy - 170, gy - 330, gy - 490];
      for (const ry of rows) {
        const n = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < n; i++) {
          const w = rand(190, 380);
          const px = rand(60, W - 60 - w);
          const py = ry + rand(-40, 40);
          if (this.plats.some((q) => Math.abs(q.y - py) < 70 &&
              px < q.x + q.w + 60 && px + w > q.x - 60)) continue;
          this.plats.push({ x: px, y: py, w, h: 24, solid: false });
        }
      }
      // corps statiques Planck
      for (const q of this.plats) {
        const b = this.pw.createBody({ position: V(q.x + q.w / 2, q.y + q.h / 2) });
        const fx = b.createFixture({
          shape: new pl.Box(q.w / 2 / S, q.h / 2 / S), friction: 0.6,
          filterCategoryBits: CAT.WORLD, filterMaskBits: CAT.BODY | CAT.LIMB,
        });
        fx.setUserData(q.solid ? { world: true } : { world: true, oneway: true, top: q.y });
        this.platBodies.push(b);
      }
      // points d'apparition répartis sur les plateformes
      this.spawns = [];
      for (const q of this.plats) {
        this.spawns.push({ x: q.x + q.w * 0.5, y: q.y });
        if (q.w > 300) {
          this.spawns.push({ x: q.x + q.w * 0.2, y: q.y });
          this.spawns.push({ x: q.x + q.w * 0.8, y: q.y });
        }
      }
    }

    startRound() {
      this.round.n++;
      this.round.phase = 'play';
      this.round.timer = 0;
      this.round.winner = '';
      for (const w of this.weapons.values()) this.pw.destroyBody(w.body);
      this.weapons.clear();
      this.newMap();
      // répartit les joueurs sur des spawns distincts (les cadavres de la
      // manche précédente disparaissent : les pantins sont reconstruits)
      const pool = this.spawns.slice().sort(() => Math.random() - 0.5);
      let i = 0;
      for (const p of this.players.values()) {
        this.spawn(p);
        const s = pool[i++ % pool.length];
        this.teleport(p.id, s.x, s.y);
      }
    }

    // ---------- boucle ----------
    tick(dtMs) {
      const dt = dtMs / 1000;
      for (const p of this.players.values()) {
        if (!p.dead && p.ragdoll) this._control(p, dt, dtMs);
      }
      this.pw.step(dt, 8, 3);
      this._tickWeapons(dtMs);
      for (const p of this.players.values()) {
        if (p.ragdoll) {
          const t = p.ragdoll.torso.getPosition();
          p.x = t.x * S;
          p.y = t.y * S + 20;
        }
        p.ht = Math.max(0, p.ht - dtMs);
        if (p.dead) {
          // cadavre parti dans le vide : inutile de le simuler encore
          if (p.ragdoll && (p.y > C.WORLD.H + C.KILL_Y * 2 ||
              p.x < -C.KILL_X * 2 || p.x > C.WORLD.W + C.KILL_X * 2)) {
            this._destroyRagdoll(p);
          }
          continue;
        }
        // chute hors de l'arène
        if (p.y > C.WORLD.H + C.KILL_Y ||
            p.x < -C.KILL_X || p.x > C.WORLD.W + C.KILL_X) {
          this._die(p);
          continue;
        }
        // fenêtre active du coup de bâton
        if (p.atkT >= 0) {
          p.atkT += dtMs;
          if (p.atkT >= C.ATK_HIT_FROM && p.atkT <= C.ATK_HIT_TO) this.resolveHits(p);
          if (p.atkT > C.ATK_TOTAL_MS) p.atkT = -1;
        }
      }
      // fin de manche : dernier survivant — et en solo, mourir relance la partie
      if (this.round.phase === 'play' && this.players.size > 0) {
        const alive = [...this.players.values()].filter((p) => !p.dead);
        if (this.players.size > 1 ? alive.length <= 1 : alive.length === 0) {
          this.round.phase = 'over';
          this.round.timer = C.ROUND_END_MS;
          const w = alive[0] || null;
          if (w) { w.score++; this.round.winner = w.name; }
          else this.round.winner = '';
        }
      } else if (this.round.phase === 'over') {
        this.round.timer -= dtMs;
        if (this.round.timer <= 0) this.startRound();
      }
    }

    _control(p, dt, dtMs) {
      const r = p.ragdoll, inp = p.input;
      const torso = r.torso;
      const vel = torso.getLinearVelocity();
      const vxPx = vel.x * S, vyPx = vel.y * S;

      const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      // on regarde vers la souris, pas vers où l'on court (façon Stick Fight)
      p.facing = Math.cos(p.aim) >= 0 ? 1 : -1;
      p.stagger = Math.max(0, p.stagger - dtMs);
      p.onGround = this._grounded(p, vyPx);

      // régénération du bouclier après un répit sans dégât
      p.shT += dtMs;
      if (p.shT > C.SHIELD_DELAY_MS && p.sh < C.SHIELD) {
        p.sh = Math.min(C.SHIELD, p.sh + C.SHIELD_REGEN * dt);
      }

      // collé à une paroi (chewing-gum) : en poussant vers un mur en l'air,
      // on glisse lentement et on peut ressauter pour remonter
      const dirWall = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      let onWall = false;
      if (!p.onGround && dirWall !== 0 && p.stagger <= 0) {
        const t = torso.getPosition();
        const wx = t.x * S, wyC = t.y * S;
        // trois hauteurs (tête, torse, pieds) : les flancs des blocs sont
        // bas, il faut pouvoir agripper le rebord en tombant devant
        for (const dy of [-24, 0, 18]) {
          this.pw.rayCast(V(wx, wyC + dy), V(wx + dirWall * 24, wyC + dy), (fixture) => {
            const ud = fixture.getUserData();
            if (!ud || !ud.world || ud.oneway) return -1; // parois solides seulement
            onWall = true;
            return 0;
          });
          if (onWall) break;
        }
      }

      // vitesse horizontale pilotée (accélération / friction) tant qu'on
      // n'est pas sonné ; la projection d'un coup reste donc physique
      let vx = vxPx, vy = vyPx;
      const target = dir * C.MOVE;
      const acc = (p.onGround ? C.ACCEL : C.AIR_ACCEL) * dt;
      if (p.stagger <= 0) {
        if (dir !== 0) {
          if (vx < target) vx = Math.min(target, vx + acc);
          else vx = Math.max(target, vx - acc);
        } else if (p.onGround) {
          const f = C.FRICTION * dt;
          vx = Math.abs(vx) <= f ? 0 : vx - Math.sign(vx) * f;
        }
      }
      // glissade lente le long de la paroi
      if (onWall && vy > C.WALL_SLIDE_VY) vy = C.WALL_SLIDE_VY;

      // saut (double saut autorisé) + tolérance "coyote" + saut mural
      p.coyote = p.onGround ? C.COYOTE_MS : Math.max(0, p.coyote - dtMs);
      if (p.onGround && vyPx >= 0) p.jumps = 0;
      if (inp.jump) {
        inp.jump = false;
        if (p.onGround || p.coyote > 0 || onWall) {
          vy = -C.JUMP; p.jumps = 1; p.coyote = 0;
        } else if (p.jumps < 2) {
          vy = -C.DOUBLE_JUMP; p.jumps = 2;
        }
      }
      torso.setLinearVelocity(new pl.Vec2(vx / S, vy / S));

      // équilibre : ressort angulaire qui tient la capsule debout, penchée
      // dans le sens de la course — très affaibli juste après un coup reçu,
      // d'où le chancellement chewing-gum
      // tous les dosages du "feel" viennent de C.TUNE (réglables en direct, touche T)
      const T = C.TUNE;
      const lean = clamp(vxPx / C.MOVE, -1, 1) * T.LEAN;
      const k = p.stagger > 0 ? 2 : (p.onGround ? T.K_SOL : T.K_AIR);
      const d = p.stagger > 0 ? 0.3 : T.AMORTI;
      torso.applyTorque(-(torso.getAngle() - lean) * k - torso.getAngularVelocity() * d);

      // couples max ré-appliqués chaque tick pour suivre les réglages en direct
      r.hips[0].setMaxMotorTorque(T.T_JAMBES);
      r.hips[1].setMaxMotorTorque(T.T_JAMBES);
      r.shoulders[0].setMaxMotorTorque(T.T_BRAS);
      r.shoulders[1].setMaxMotorTorque(T.T_BRAS2);
      r.neck.setMaxMotorTorque(T.T_COU);

      // démarche : les hanches suivent une sinusoïde ; jambes repliées en l'air
      const run = Math.min(1, Math.abs(vxPx) / C.MOVE);
      if (p.onGround) p.phase += Math.abs(vxPx) * dt * 0.05;
      const swing = Math.sin(p.phase) * T.FOULEE * run;
      this._servo(r.hips[0], p.onGround ? swing : 0.55, T.G_JAMBES);
      this._servo(r.hips[1], p.onGround ? -swing : -0.3, T.G_JAMBES);
      this._servo(r.neck, 0, T.G_COU);

      // lancer du bâton : il part en tournoyant dans la direction de visée
      if (inp.throw) {
        inp.throw = false;
        if (p.weapon && p.atkT < 0) {
          p.weapon = false;
          const dx = Math.cos(p.aim), dy = Math.sin(p.aim);
          this._spawnWeapon(
            p.x + dx * 30, p.y - 34 + dy * 30,
            dx * C.THROW_SPEED + vxPx * 0.5, dy * C.THROW_SPEED,
            34 * p.facing, p.id);   // rotation d'hélice
        }
      }

      // attaque (au bâton, ou poings / pieds en alternance à mains nues)
      p.cd = Math.max(0, p.cd - dtMs);
      if (inp.attack) {
        inp.attack = false;
        if (p.cd <= 0 && p.atkT < 0) {
          p.atkT = 0;
          p.cd = C.ATK_COOLDOWN_MS;
          p.hitIds.clear();
          p.combo++;
        }
      }
      const kicking = !p.weapon && p.atkT >= 0 && p.combo % 2 === 0;
      // bras d'attaque asservi vers la souris ; pendant le coup il balaie
      // un grand arc autour de la direction de visée (plus court au poing)
      let rel = (p.weapon ? -0.35 : -0.15) * p.facing;
      if (p.atkT >= 0 && !kicking) {
        const q = Math.min(1, p.atkT / C.ATK_TOTAL_MS);
        const e = 1 - (1 - q) * (1 - q);
        rel = (p.weapon ? (-1.7 + e * 3.0) : (-0.9 + e * 1.4)) * p.facing;
      }
      // consigne du joint : angle monde voulu, moins l'angle du torse, moins
      // la référence π/2 (le bras est créé pendant vers le bas)
      this._servo(r.shoulders[0], p.aim + rel - torso.getAngle() - Math.PI / 2, T.G_BRAS);
      // bras arrière : balance en course, tenu sinon
      this._servo(r.shoulders[1], -Math.sin(p.phase) * 0.8 * run, 8);
      // coup de pied : la jambe avant part violemment vers la visée
      if (kicking) {
        r.hips[0].setMaxMotorTorque(T.T_JAMBES * 2.5);
        this._servo(r.hips[0], p.aim - torso.getAngle() - Math.PI / 2, 30);
      }
    }

    _servo(joint, targetAngle, gain) {
      // asservissement en vitesse vers l'angle cible, par le chemin le plus court
      const d = norm(targetAngle - joint.getJointAngle());
      joint.setMotorSpeed(clamp(d * gain, -40, 40));
    }

    _grounded(p, vyPx) {
      if (vyPx < -60) return false;   // en pleine ascension
      const t = p.ragdoll.torso.getPosition();
      const x = t.x * S, y = t.y * S; // centre de la capsule, pieds ≈ y+20
      let hit = false;
      this.pw.rayCast(V(x, y + 12), V(x, y + 27), (fixture) => {
        const ud = fixture.getUserData();
        if (!ud || !ud.world) return -1;                    // pas le décor
        if (ud.oneway && y + 20 > ud.top + 6) return -1;    // on est dedans
        hit = true;
        return 0;
      });
      return hit;
    }

    resolveHits(p) {
      // le coup part de la poitrine, dans la direction de la souris ;
      // à mains nues : portée et dégâts réduits
      const range = C.ATK_RANGE * (p.weapon ? 1 : C.FIST_RANGE_MUL);
      const baseDmg = p.weapon ? C.ATK_DMG : C.FIST_DMG;
      const dx = Math.cos(p.aim), dy = Math.sin(p.aim);
      const ox = p.x, oy = p.y - C.PLAYER.H * 0.55;
      const cx = ox + dx * range * 0.7;   // centre de la zone de frappe
      const cy = oy + dy * range * 0.7;
      for (const e of this.players.values()) {
        if (e === p || e.dead || !e.ragdoll || p.hitIds.has(e.id)) continue;
        // la tête d'abord : coup critique, mais il faut viser assez haut
        const headY = e.y - C.PLAYER.H + 9;
        let dmg = 0, crit = false;
        if (cy <= e.y - C.PLAYER.H + 22 &&
            Math.hypot(cx - e.x, cy - headY) < C.ATK_RADIUS + C.HEAD_R) {
          dmg = Math.round(baseDmg * C.ATK_HEAD_MULT);
          crit = true;
        } else {
          const bodyY = e.y - C.PLAYER.H * 0.45;
          if (Math.hypot(cx - e.x, cy - bodyY) < C.ATK_RADIUS + 20) dmg = baseDmg;
        }
        if (!dmg) continue;
        p.hitIds.add(e.id);
        this._damage(e, dmg);
        e.ht = C.HIT_FLASH_MS * (crit ? 1.8 : 1);
        e.htCrit = crit;
        e.stagger = 320;
        // projection dans la direction du coup, amplifiée par les dégâts
        // subis (façon Smash), avec une rotation pour l'effet chiffon
        const scale = 0.7 + ((C.HP - Math.max(0, e.hp)) / C.HP) * 1.4;
        const tb = e.ragdoll.torso;
        tb.setLinearVelocity(new pl.Vec2(
          dx * C.KNOCK * scale / S,
          (dy * C.KNOCK * scale * 0.85 - 150) / S
        ));
        tb.setAngularVelocity(p.facing * 4 * scale);
        if (e.hp <= 0) { e.hp = 0; this._die(e); }
      }
    }

    // ---------- réseau ----------
    leaderboard() {
      return [...this.players.values()]
        .sort((a, b) => b.score - a.score)
        .map((p) => ({ id: p.id, name: p.name, score: p.score }));
    }

    // points du pantin pour le rendu : torse (pos + angle), tête, mains,
    // pieds, angle du bâton — le dessin relie ces points physiques
    viewPlayer(p) {
      const r = p.ragdoll;
      if (!r) return null;
      const px = (v) => Math.round(v * S);
      const t = r.torso.getPosition(), h = r.head.getPosition();
      const hand = r.arms[0].getWorldPoint(new pl.Vec2(18 / S, 0));
      const hand2 = r.arms[1].getWorldPoint(new pl.Vec2(18 / S, 0));
      const foot1 = r.legs[0].getWorldPoint(new pl.Vec2(26 / S, 0));
      const foot2 = r.legs[1].getWorldPoint(new pl.Vec2(26 / S, 0));
      return [
        px(t.x), px(t.y), r2(r.torso.getAngle()),
        px(h.x), px(h.y),
        px(hand.x), px(hand.y), px(hand2.x), px(hand2.y),
        px(foot1.x), px(foot1.y), px(foot2.x), px(foot2.y),
        r2(r.arms[0].getAngle()),
      ];
    }

    viewWeapons() {
      return [...this.weapons.values()].map((w) => {
        const q = w.body.getPosition();
        return [Math.round(q.x * S), Math.round(q.y * S), r2(w.body.getAngle())];
      });
    }

    snapshot() {
      return {
        t: 'state',
        players: [...this.players.values()].map((p) => ({
          id: p.id, n: p.name, c: p.color, f: p.facing,
          hp: p.hp, sh: Math.round(p.sh),
          d: p.dead ? 1 : 0, s: p.score, w: p.weapon ? 1 : 0,
          ht: p.ht > 0 ? (p.htCrit ? 2 : 1) : 0,
          b: this.viewPlayer(p),
        })),
        wp: this.viewWeapons(),
        plats: this.plats.map((q) => [q.x | 0, q.y | 0, q.w | 0, q.h, q.solid ? 1 : 0]),
        round: {
          n: this.round.n, ph: this.round.phase,
          tm: Math.max(0, Math.ceil(this.round.timer)), w: this.round.winner,
        },
      };
    }
  }

  const Sim = { World };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  else global.Sim = Sim;
})(typeof window !== 'undefined' ? window : globalThis);
