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
  const CAT = { WORLD: 1, BODY: 2, LIMB: 4, DEBRIS: 8 };

  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function norm(a) {
    return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  }
  // distance d'un point (px,py) au segment (x1,y1)-(x2,y2)
  function segDist(x1, y1, x2, y2, px, py) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
  }

  class World {
    constructor() {
      this.players = new Map();   // id -> joueur
      this.plats = [];            // {x,y,w,h,solid} — x,y = coin haut-gauche
      this.platBodies = [];       // corps statiques Planck correspondants
      this.spawns = [];           // {x,y} — pieds posés sur une plateforme
      this.round = { n: 1, phase: 'play', timer: 0, winner: '' };
      this.weapons = new Map();   // armes libres (lancées / lâchées / larguées)
      this.theme = 0;             // index dans C.THEMES
      this.hazards = [];          // pics {x,y,w,h}
      this.lava = null;           // {y, rise, max} — surface, vitesse, plafond
      this.mapT = 0;              // horloge des objets animés de la carte
      this.balls = [];            // boules piquantes {ax,ay,L,amp,om,ph,x,y}
      this.lasers = [];           // rayons {x1,y1,x2,y2,ph,on}
      this.swings = [];           // balançoires {ax,ay,L,amp,om,ph,w,body}
      this.crates = [];           // caisses poussables {body,s}
      this.mapBodies = [];        // corps Planck des objets (détruits au reset)
      this.iceChunks = [];        // éclats de glace en vol / posés {body,s,t}
      this.customMap = null;      // map de l'éditeur ; null = cartes aléatoires
      this.mapDrops = true;       // les armes tombent-elles du ciel ?
      this._wid = 0;
      this.bullets = [];          // balles en vol
      this.booms = [];            // explosions en cours (effet + fenêtre rendu)
      this.dropT = C.DROP_MS;     // compte à rebours du prochain largage
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
        blocking: false,          // bouclier levé (clic droit maintenu)
        atkT: -1,                 // ms depuis le début du coup, -1 = inactif
        cd: 0,                    // recharge de l'attaque
        ht: 0,                    // flash "touché"
        htCrit: false,            // le dernier coup reçu était un coup à la tête
        stagger: 0,               // équilibre affaibli juste après un coup reçu
        limp: 0,                  // affalé au sol (écrasé par un bloc), gigote
        phase: 0,                 // phase de la démarche
        hitIds: new Set(),        // déjà touchés pendant ce coup
        weapon: 'baton',          // type d'arme tenue, null = poings et pieds
        ammo: 0,                  // munitions restantes (armes à feu)
        kame: 0,                  // ms restants du poing Kaméaméa chargé
        hzCd: 0,                  // invulnérabilité aux pics (ms restants)
        spin: 0,                  // rotation de souris cumulée (charge en cours)
        spinIdle: 0, _pa: 0,      // pause de rotation + dernier angle de visée
        mu: 0,                    // flash de bouche (ms restants)
        combo: 0,                 // alterne poing / pied à mains nues
        ragdoll: null,
        input: {
          left: false, right: false, jump: false, down: false,
          attack: false, attackHeld: false, throw: false, block: false,
        },
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
      p.input.down = !!msg.dn;
      p.input.block = !!msg.bl;
      p.input.attackHeld = !!msg.ah;
      if (typeof msg.m === 'number' && isFinite(msg.m)) p.aim = msg.m;
      // sauts et coups sont des impulsions : on les accumule jusqu'au
      // prochain tick pour ne jamais en perdre entre deux envois réseau
      if (msg.j) p.input.jump = true;
      if (msg.a) p.input.attack = true;
      if (msg.tr) p.input.throw = true;
    }

    spawn(p, slot) {
      const s = slot || this.spawns[Math.floor(Math.random() * this.spawns.length)];
      this._destroyRagdoll(p);
      p.ragdoll = this._buildRagdoll(s.x, s.y);
      p.x = s.x; p.y = s.y;
      p.hp = C.HP; p.dead = false;
      p.sh = C.SHIELD; p.shT = 9999;
      p.atkT = -1; p.cd = 0; p.ht = 0; p.htCrit = false;
      p.stagger = 0; p.limp = 0; p.phase = 0;
      // arme de départ imposée par le point d'apparition (éditeur), sinon bâton
      const wk = s && s.weapon;
      if (wk === 'poings') { p.weapon = null; p.ammo = 0; }
      else if (wk && C.WEAPONS[wk]) { p.weapon = wk; p.ammo = C.WEAPONS[wk].ammo || 0; }
      else { p.weapon = 'baton'; p.ammo = 0; }
      p.mu = 0;
      p.kame = 0; p.spin = 0; p.spinIdle = 0; p._pa = p.aim;
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
        // amortissement angulaire modéré : un peu de ballant, mais il tient
        type: 'dynamic', position: V(x, y - 20), angularDamping: 0.6,
      });
      r.torso.createFixture({
        shape: new pl.Box(13 / S, 20 / S), density: 1, friction: 0.05,
        // le torse heurte le décor ET les morceaux de glace (qui l'écrasent)
        filterCategoryBits: CAT.BODY, filterMaskBits: CAT.WORLD | CAT.DEBRIS,
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

    // bouclier levé : la jauge encaisse (le surplus passe aux PV) ;
    // sinon les dégâts vont directement aux PV
    _damage(e, dmg) {
      e.shT = 0;
      if (e.blocking && e.sh > 0) {
        const ab = Math.min(e.sh, dmg);
        e.sh -= ab;
        e.hp -= dmg - ab;
      } else {
        e.hp -= dmg;
      }
    }

    _die(p) {
      p.dead = true;
      // on lâche son arme en mourant
      if (p.weapon && p.ragdoll) {
        const v = p.ragdoll.torso.getLinearVelocity();
        this._spawnWeapon(p.x, p.y - 40, v.x * S * 0.5, v.y * S * 0.5 - 120,
          rand(-8, 8), null, p.weapon, p.ammo);
        p.weapon = null;
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
    _spawnWeapon(x, y, vx, vy, spin, thrower, type, ammo) {
      const b = this.pw.createBody({
        type: 'dynamic', position: V(x, y), angle: Math.atan2(vy, vx),
        bullet: true, angularDamping: 0.05,
      });
      // en vol rapide : trajectoire tendue, il file droit vers la cible ;
      // une arme blanche part comme un javelot (aucune gravité en vol),
      // la gravité normale revient une fois ralenti
      const melee = (C.WEAPONS[type || 'baton'] || {}).melee;
      if (Math.hypot(vx, vy) > 500) b.setGravityScale(melee ? 0 : 0.3);
      // collision : petite boule au centre (le bâton visuel tournoie autour) —
      // sinon les extrémités raclent le sol en plein vol et le font ricocher
      b.createFixture({
        shape: new pl.Circle(6 / S), density: 2,
        friction: 0.6, restitution: 0.25,
        filterCategoryBits: CAT.LIMB, filterMaskBits: CAT.WORLD,
      });
      b.setLinearVelocity(new pl.Vec2(vx / S, vy / S));
      b.setAngularVelocity(spin);
      this.weapons.set(++this._wid, {
        body: b, thrower, t: 0, type: type || 'baton',
        ammo: ammo === undefined ? (C.WEAPONS[type || 'baton'].ammo || 0) : ammo,
      });
    }

    // largage : une arme aléatoire tombe du ciel en cours de manche
    _tickDrops(dtMs) {
      if (!this.mapDrops) return;   // largages désactivés pour cette map
      if (this.players.size < 2 || this.round.phase !== 'play') return;
      this.dropT -= dtMs;
      if (this.dropT > 0) return;
      this.dropT = C.DROP_MS * rand(0.7, 1.4);
      if (this.weapons.size >= C.DROP_MAX) return;
      const type = C.DROPS[Math.floor(Math.random() * C.DROPS.length)];
      this._spawnWeapon(rand(120, C.WORLD.W - 120), -60, 0, 80, rand(-3, 3), null, type);
      // largage en douceur : quasi sans gravité, la chute est plafonnée
      // dans _tickWeapons — on peut la cueillir au vol
      const w = this.weapons.get(this._wid);
      w.drop = true;
      w.body.setGravityScale(0.1);
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
        // largage : descente plafonnée jusqu'au sol (le ramassage plus bas
        // reste actif, on peut donc la cueillir en plein vol)
        if (w.drop && v.y * S > C.DROP_FALL) {
          w.body.setLinearVelocity(new pl.Vec2(v.x, C.DROP_FALL / S));
        }
        if (!w.drop && sp < 500) {
          w.body.setGravityScale(1);      // fin du vol tendu
          w.body.setAngularDamping(3);    // l'hélice s'arrête de rouler
        }
        if (sp > 350) {
          // projectile : blesse ce qu'il croise (une victime par lancer)
          for (const e of this.players.values()) {
            if (e.dead || !e.ragdoll) continue;
            if (e.id === w.thrower && w.t < 350) continue; // pas le lanceur au départ
            if (Math.hypot(wx - e.x, wy - (e.y - C.PLAYER.H * 0.5)) > 40) continue;
            this._damage(e, (C.WEAPONS[w.type] && C.WEAPONS[w.type].throwDmg) || C.THROW_DMG);
            e.ht = C.HIT_FLASH_MS * 1.8;
            e.htCrit = false;
            e.stagger = 350;
            const scale = (0.7 + ((C.HP - Math.max(0, e.hp)) / C.HP) * 1.4) *
          (e.blocking ? 0.35 : 1);   // bien campé derrière son bouclier
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
              e.weapon = w.type;
              e.ammo = w.ammo;
              this.pw.destroyBody(w.body);
              this.weapons.delete(id);
              break;
            }
          }
        }
      }
    }

    // ---------- dangers : pics et lave ----------
    _tickHazards(dtMs) {
      const dt = dtMs / 1000;
      if (this.lava && this.lava.rise && this.round.phase === 'play') {
        this.lava.y = Math.max(this.lava.max, this.lava.y - this.lava.rise * dt);
      }
      for (const p of this.players.values()) {
        if (p.dead || !p.ragdoll) continue;
        p.hzCd = Math.max(0, p.hzCd - dtMs);
        // lave : brûlure continue, et elle recrache vers le haut
        if (this.lava && p.y > this.lava.y + 4) {
          this._damage(p, C.LAVA_DPS * dt);
          if (p.hzCd <= 0) { p.hzCd = 250; p.ht = C.HIT_FLASH_MS; p.htCrit = false; }
          p.stagger = Math.max(p.stagger, 200);
          const tv = p.ragdoll.torso.getLinearVelocity();
          if (tv.y * S > -300) {
            p.ragdoll.torso.setLinearVelocity(new pl.Vec2(tv.x, -C.LAVA_KNOCK / S));
          }
        } else if (p.hzCd <= 0) {
          // pics : mort instantanée au contact (bouclier inutile), le
          // pantin est projeté vers le haut au moment d'être empalé
          for (const h of this.hazards) {
            if (p.x < h.x - 6 || p.x > h.x + h.w + 6 ||
                p.y < h.y - 2 || p.y > h.y + h.h + 24) continue;
            p.hzCd = C.HAZARD_CD_MS;
            p.hp = 0;
            p.ht = C.HIT_FLASH_MS * 1.8; p.htCrit = true;
            p.stagger = 300;
            const tv = p.ragdoll.torso.getLinearVelocity();
            p.ragdoll.torso.setLinearVelocity(new pl.Vec2(tv.x, -700 / S));
            break;
          }
        }
        if (p.hp <= 0) { p.hp = 0; this._die(p); }
      }
    }

    // ---------- objets animés de la carte ----------
    _tickMapObjects(dtMs) {
      const dt = dtMs / 1000;
      this.mapT += dtMs;
      const t = this.mapT / 1000;

      // boules piquantes : pendule, mort instantanée au contact + grosse
      // projection (le bouclier ne protège pas d'un pieu en pleine face)
      for (const b of this.balls) {
        const th = b.amp * Math.sin(b.om * t + b.ph);
        b.x = b.ax + Math.sin(th) * b.L;
        b.y = b.ay + Math.cos(th) * b.L;
        for (const p of this.players.values()) {
          if (p.dead || !p.ragdoll || p.hzCd > 0) continue;
          const cy = p.y - C.PLAYER.H * 0.5;
          const d = Math.hypot(b.x - p.x, b.y - cy);
          if (d > b.r + 22) continue;
          p.hzCd = C.HAZARD_CD_MS;
          p.hp = 0;
          p.ht = C.HIT_FLASH_MS * 1.8; p.htCrit = true;
          p.stagger = 400;
          const nx = (p.x - b.x) / (d || 1), ny = (cy - b.y) / (d || 1);
          p.ragdoll.torso.setLinearVelocity(new pl.Vec2(
            nx * C.BALL_KNOCK / S, (ny * C.BALL_KNOCK - 250) / S));
          this._die(p);
        }
      }

      // lasers clignotants : traverser un rayon allumé coûte cher
      for (const l of this.lasers) {
        const cyc = (this.mapT + l.ph) % (C.LASER_ON_MS + C.LASER_OFF_MS);
        l.on = cyc < C.LASER_ON_MS;
        if (!l.on) continue;
        for (const p of this.players.values()) {
          if (p.dead || !p.ragdoll || p.hzCd > 0) continue;
          if (segDist(l.x1, l.y1, l.x2, l.y2, p.x, p.y - C.PLAYER.H * 0.5) > 18) continue;
          p.hzCd = C.HAZARD_CD_MS;
          this._damage(p, C.LASER_DMG);
          p.ht = C.HIT_FLASH_MS; p.htCrit = false;
          p.stagger = 300;
          if (p.hp <= 0) { p.hp = 0; this._die(p); }
        }
      }

      // balançoires : la planche suit son arc de pendule (vitesse imposée,
      // pour que la friction emporte ceux qui sont debout dessus)
      for (const sw of this.swings) {
        const th = sw.amp * Math.sin(sw.om * t + sw.ph);
        const tx = sw.ax + Math.sin(th) * sw.L, ty = sw.ay + Math.cos(th) * sw.L;
        const q = sw.body.getPosition();
        sw.body.setLinearVelocity(new pl.Vec2(
          (tx / S - q.x) / dt, (ty / S - q.y) / dt));
        sw.body.setAngularVelocity((-th * 0.5 - sw.body.getAngle()) / dt);
      }

      // caisses parties dans le vide (trou ou lave montante)
      for (let i = this.crates.length - 1; i >= 0; i--) {
        const q = this.crates[i].body.getPosition();
        if (q.y * S > C.WORLD.H + C.KILL_Y * 2) {
          this.pw.destroyBody(this.crates[i].body);
          const bi = this.mapBodies.indexOf(this.crates[i].body);
          if (bi >= 0) this.mapBodies.splice(bi, 1);
          this.crates.splice(i, 1);
        }
      }

      // sols clignotants et friables
      for (const q of this.plats) {
        if (q.mode === 'blink') {
          const cyc = (this.mapT + q.ph) % (C.BLINK_ON_MS + C.BLINK_OFF_MS);
          const off = cyc >= C.BLINK_ON_MS;
          if (off !== !!q.off) { q.off = off; q.body.setActive(!off); }
        } else if (q.mode === 'crumble' && !q.off) {
          if (q.timer > 0) {
            q.timer -= dtMs;
            if (q.timer <= 0) { q.off = true; q.body.setActive(false); }
          } else {
            // un joueur pose le pied dessus : le bloc tremble puis cède
            for (const p of this.players.values()) {
              if (p.dead || !p.onGround) continue;
              if (p.x > q.x - 6 && p.x < q.x + q.w + 6 &&
                  Math.abs(p.y - q.y) < 12) { q.timer = C.CRUMBLE_MS; break; }
            }
          }
        }
      }
    }

    // vrai (bloc de glace) tuile encore présente au-dessus de x
    _iceSolidAt(q, x) {
      return q.tiles && q.tiles.some((t) => t.alive && Math.abs(t.cx - x) <= t.tw / 2 + 2);
    }

    // détache une tuile de la plateforme de glace : la fixture disparaît (le
    // reste du bloc tient toujours) et le morceau tombe en débris physique
    _breakIceTile(q, t) {
      if (!t.alive) return;
      t.alive = false;
      q.body.destroyFixture(t.fx);
      // le morceau naît juste SOUS la plateforme : il tombe librement sans se
      // coincer contre les tuiles voisines encore en place. Grand éclat (toute
      // la largeur de la tuile, presque toute la hauteur du bloc)
      const ch = Math.min(q.h, 62), cw = t.tw + 6;
      this._spawnIceChunk(t.cx, q.y + q.h + ch / 2 + 1,
        rand(-25, 25), rand(40, 120), cw, ch);
      // + quelques petits bouts qui se détachent et s'éparpillent
      const bits = 1 + (Math.random() < 0.5 ? 1 : 0);
      for (let k = 0; k < bits; k++) {
        const bs = rand(9, 17);
        this._spawnIceChunk(t.cx + rand(-t.tw * 0.35, t.tw * 0.35),
          q.y + q.h + bs / 2 + 1, rand(-90, 90), rand(20, 110), bs, bs);
      }
      if (q.tiles.every((u) => !u.alive)) q.off = true;   // plus rien : trou total
    }

    // glace touchée par une balle ou une explosion : les tuiles proches de
    // l'impact se détachent (plus de tuiles quand les dégâts sont élevés)
    _damageIce(q, dmg, hx, hy) {
      if (!q.ice || q.off || !q.tiles) return;
      const x = hx !== undefined ? hx : q.x + q.w / 2;
      const nbreak = Math.max(1, Math.round(dmg / 20));
      const alive = q.tiles.filter((t) => t.alive)
        .sort((a, b) => Math.abs(a.cx - x) - Math.abs(b.cx - x));
      for (let i = 0; i < nbreak && i < alive.length; i++) this._breakIceTile(q, alive[i]);
    }

    // un morceau de glace tombé de la plateforme : corps dynamique qui heurte
    // le décor et les autres morceaux, mais traverse les joueurs (ses dégâts
    // de chute sont gérés à la main)
    _spawnIceChunk(x, y, vx, vy, w, h) {
      if (this.iceChunks.length >= C.ICE_CHUNK_MAX) {
        this.pw.destroyBody(this.iceChunks.shift().body);
      }
      const cw = w || C.ICE_TILE, ch = h || C.ICE_TILE;
      // esquille de glace anguleuse (façon jeu d'origine) : peu de sommets et
      // un rayon très bruité => des pointes et des faces franches, pas un galet
      const n = 4 + Math.floor(Math.random() * 3);   // 4 à 6 sommets
      const verts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.35, 0.35);
        const rx = (cw / 2) * (0.5 + Math.random() * 0.5);
        const ry = (ch / 2) * (0.5 + Math.random() * 0.5);
        verts.push([Math.round(Math.cos(a) * rx), Math.round(Math.sin(a) * ry)]);
      }
      const b = this.pw.createBody({
        type: 'dynamic', position: V(x, y), angle: rand(-0.6, 0.6),
      });
      b.createFixture({
        // Planck calcule l'enveloppe convexe des sommets fournis
        shape: new pl.Polygon(verts.map((v) => new pl.Vec2(v[0] / S, v[1] / S))),
        density: 0.6, friction: 0.6, restitution: 0.08,
        // heurte le décor, les autres morceaux ET le torse des joueurs (écrase)
        filterCategoryBits: CAT.DEBRIS,
        filterMaskBits: CAT.WORLD | CAT.DEBRIS | CAT.BODY,
      });
      b.setLinearVelocity(new pl.Vec2(vx / S, vy / S));
      b.setAngularVelocity(rand(-6, 6));   // il tournoie en tombant
      // vy0 = vitesse de chute d'approche (avant que le choc ne la freine),
      // utilisée pour les dégâts ; hit = joueurs déjà écrasés par ce morceau
      this.iceChunks.push({ body: b, w: cw, h: ch, verts, t: 0, vy0: vy, hit: new Set() });
    }

    // chute des morceaux : ceux qui tombent vite écrasent le joueur touché,
    // l'enfoncent au sol, puis retombent physiquement dessus/à côté (ils ne
    // sont PAS absorbés) ; les autres se posent et restent sur les plateformes
    _tickIceChunks(dtMs) {
      for (let i = this.iceChunks.length - 1; i >= 0; i--) {
        const c = this.iceChunks[i];
        c.t += dtMs;
        const q = c.body.getPosition();
        const cx = q.x * S, cy = q.y * S;
        if (cy > C.WORLD.H + C.KILL_Y * 2 ||
            cx < -C.KILL_X * 2 || cx > C.WORLD.W + C.KILL_X * 2) {
          this.pw.destroyBody(c.body);
          this.iceChunks.splice(i, 1);
          continue;
        }
        const vyNow = c.body.getLinearVelocity().y * S;
        // vy0 = vitesse d'approche du tick précédent : le choc physique freine
        // le morceau avant qu'on le lise, donc on se sert de la vitesse d'avant
        const vy = c.vy0;
        if (vy >= C.ICE_FALL_MIN_VY) {
          for (const p of this.players.values()) {
            if (p.dead || !p.ragdoll || c.hit.has(p.id)) continue;
            // le morceau survole le joueur et arrive sur la hauteur de son
            // corps (jusqu'au-dessus de la tête : un bloc sur le crâne compte)
            if (Math.abs(cx - p.x) > c.w / 2 + C.PLAYER.W / 2 + 6) continue;
            if (cy < p.y - C.PLAYER.H - 16 || cy > p.y - 4) continue;
            c.hit.add(p.id);
            const dmg = clamp(Math.round((vy - C.ICE_FALL_MIN_VY) / 45) + 4,
              4, C.ICE_FALL_DMG_MAX);
            this._damage(p, dmg);
            p.ht = C.HIT_FLASH_MS; p.htCrit = false;
            // écrasé : enfoncé au sol (≥ 90 % de la vitesse de chute), puis
            // affalé mou sous le bloc — il faut gigoter pour s'en extraire
            p.stagger = Math.max(p.stagger, 200);
            p.limp = C.CRUSH_LIMP_MS;
            const tv = p.ragdoll.torso.getLinearVelocity();
            p.ragdoll.torso.setLinearVelocity(new pl.Vec2(
              tv.x * 0.35, Math.max(tv.y * S, vy * 0.9 + 400) / S));
            // coup de rotation pour amorcer l'affalement à plat
            p.ragdoll.torso.setAngularVelocity(p.facing * 8);
            if (p.hp <= 0) { p.hp = 0; this._die(p); }
            break;
          }
        }
        c.vy0 = vyNow;   // mémorise pour le tick suivant
      }
    }

    // ---------- balles ----------
    _fire(p, W) {
      p.cd = W.rate;
      p.ammo--;
      p.mu = 70;
      const n = W.pellets || 1;
      for (let i = 0; i < n; i++) {
        const ang = p.aim + (W.spread ? (Math.random() - 0.5) * 2 * W.spread : 0);
        this.bullets.push({
          x: p.x + Math.cos(p.aim) * 28, y: p.y - 34 + Math.sin(p.aim) * 28,
          vx: Math.cos(ang) * W.speed, vy: Math.sin(ang) * W.speed,
          t: 0, dmg: W.dmg, o: p.id,
          g: W.grav || 0, expl: W.expl || 0,
        });
      }
      // recul : forte poussée à l'opposé de la visée (les grosses armes te
      // projettent). Verticalement à 0,8 : viser le sol te fait décoller.
      // Les grosses armes ajoutent un pop vers le haut : on quitte le sol et
      // on file en l'air (sans friction) — beaucoup plus difficile à contrer.
      const pop = W.recul >= 400 ? 300 : 0;
      const tv = p.ragdoll.torso.getLinearVelocity();
      p.ragdoll.torso.setLinearVelocity(new pl.Vec2(
        tv.x - Math.cos(p.aim) * W.recul / S,
        tv.y - (Math.sin(p.aim) * W.recul * 0.8 + pop) / S));
      // au-delà d'un certain recul on est déséquilibré : on part en vrille et
      // il faut se rattraper (façon éjection Stick Fight)
      if (W.recul >= 800) p.stagger = Math.max(p.stagger, 300);
      else if (W.recul >= 220) p.stagger = Math.max(p.stagger, 130);
      if (p.ammo <= 0) p.weapon = null;   // à sec : on jette, poings et pieds
    }

    // souffle : dégâts et projection décroissants avec la distance, effet
    // visuel diffusé aux invités — le tireur n'est pas épargné (classique !)
    _explode(x, y, dmg, radius) {
      this.booms.push({ x, y, r: radius, t: C.EXPL_FX_MS });
      for (const e of this.players.values()) {
        if (e.dead || !e.ragdoll) continue;
        const cy = e.y - C.PLAYER.H * 0.5;
        const d = Math.hypot(x - e.x, y - cy);
        if (d > radius + 25) continue;
        const q = 1 - d / (radius + 25);
        this._damage(e, Math.max(6, Math.round(dmg * q)));
        e.ht = C.HIT_FLASH_MS * 1.8;
        e.htCrit = false;
        e.stagger = 420;
        const nx = d > 1 ? (e.x - x) / d : 0, ny = d > 1 ? (cy - y) / d : -1;
        const kb = C.EXPL_KNOCK * (0.4 + 0.6 * q) * (e.blocking ? 0.35 : 1);
        e.ragdoll.torso.setLinearVelocity(new pl.Vec2(
          nx * kb / S, (ny * kb - 220) / S));
        e.ragdoll.torso.setAngularVelocity((nx >= 0 ? 1 : -1) * 6 * q);
        if (e.hp <= 0) { e.hp = 0; this._die(e); }
      }
      // le souffle fait aussi voler la glace en éclats
      for (const q of this.plats) {
        if (!q.ice || q.off) continue;
        const cx = clamp(x, q.x, q.x + q.w), cy2 = clamp(y, q.y, q.y + q.h);
        if (Math.hypot(x - cx, y - cy2) < radius) this._damageIce(q, dmg, cx, cy2);
      }
    }

    _tickBullets(dtMs) {
      const dt = dtMs / 1000;
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        b.t += dtMs;
        if (b.g) b.vy += b.g * dt;   // grenades : trajectoire en cloche
        const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
        let gone = b.t > C.BULLET_LIFE_MS ||
          nx < -C.KILL_X || nx > C.WORLD.W + C.KILL_X || ny > C.WORLD.H + C.KILL_Y || ny < -600;
        // décor (on teste le point d'arrivée et le milieu du segment)
        if (!gone) {
          const mx = (b.x + nx) / 2, my = (b.y + ny) / 2;
          for (const q of this.plats) {
            if (q.off) continue;   // bloc disparu : les balles passent
            if ((nx > q.x && nx < q.x + q.w && ny > q.y && ny < q.y + q.h) ||
                (mx > q.x && mx < q.x + q.w && my > q.y && my < q.y + q.h)) {
              // glace trouée : si l'impact tombe dans un trou, la balle passe
              if (q.ice && !this._iceSolidAt(q, nx)) continue;
              this._damageIce(q, b.dmg, nx, ny);
              gone = true; break;
            }
          }
        }
        // joueurs : distance du segment parcouru à la tête (critique) ou au torse
        if (!gone) {
          for (const e of this.players.values()) {
            if (e.dead || !e.ragdoll || e.id === b.o) continue;
            // projectile explosif : pas de dégât direct, il détone au contact
            if (b.expl) {
              if (segDist(b.x, b.y, nx, ny, e.x, e.y - C.PLAYER.H * 0.45) < 28) {
                gone = true;
                break;
              }
              continue;
            }
            let dmg = 0, crit = false;
            if (segDist(b.x, b.y, nx, ny, e.x, e.y - C.PLAYER.H + 9) < 12) {
              dmg = Math.round(b.dmg * C.ATK_HEAD_MULT); crit = true;
            } else if (segDist(b.x, b.y, nx, ny, e.x, e.y - C.PLAYER.H * 0.45) < 20) {
              dmg = b.dmg;
            }
            if (!dmg) continue;
            this._damage(e, dmg);
            e.ht = C.HIT_FLASH_MS * (crit ? 1.8 : 1);
            e.htCrit = crit;
            e.stagger = Math.max(e.stagger, 140);
            const sp = Math.hypot(b.vx, b.vy) || 1;
            const kb = (80 + dmg * 7) * (e.blocking ? 0.35 : 1);
            const tv = e.ragdoll.torso.getLinearVelocity();
            e.ragdoll.torso.setLinearVelocity(new pl.Vec2(
              tv.x + (b.vx / sp) * kb / S,
              tv.y + ((b.vy / sp) * kb - 60) / S));
            if (e.hp <= 0) { e.hp = 0; this._die(e); }
            gone = true;
            break;
          }
        }
        if (gone) {
          // détonation (décor, joueur ou fin de mèche) — mais pas dans le vide
          if (b.expl && ny > -400 && ny < C.WORLD.H + C.KILL_Y &&
              nx > -C.KILL_X && nx < C.WORLD.W + C.KILL_X) {
            this._explode(nx, ny, b.dmg, b.expl);
          }
          this.bullets.splice(i, 1);
        } else { b.x = nx; b.y = ny; }
      }
    }

    // ---------- arène ----------
    // la carte suivante : celle de l'éditeur si une map personnalisée est
    // chargée (this.customMap), sinon une carte aléatoire
    newMap() {
      const { W, H } = C.WORLD;
      for (const b of this.platBodies) this.pw.destroyBody(b);
      for (const b of this.mapBodies) this.pw.destroyBody(b);
      for (const c of this.iceChunks) this.pw.destroyBody(c.body);
      // armes libres au sol : on repart de zéro (évite les doublons quand
      // l'éditeur ré-applique la map à chaque retouche)
      for (const w of this.weapons.values()) this.pw.destroyBody(w.body);
      this.weapons.clear();
      this.platBodies = [];
      this.mapBodies = [];
      this.iceChunks = [];
      this.plats = [];
      this.hazards = [];
      this.lava = null;
      this.balls = [];
      this.lasers = [];
      this.swings = [];
      this.crates = [];
      this.mapT = 0;

      let swingDefs, crateDefs, defSpawns = null, fixedW = [];
      if (this.customMap) {
        const r = this._loadDef(this.customMap);
        swingDefs = r.swings; crateDefs = r.crates;
        defSpawns = r.spawns; fixedW = r.weapons;
        this.mapDrops = this.customMap.drops !== false;   // largages (défaut oui)
      } else {
        const g = this._randomMap();
        swingDefs = g.swings; crateDefs = g.crates;
        this.mapDrops = true;
      }

      // corps statiques Planck des plateformes
      const mask = CAT.BODY | CAT.LIMB | CAT.DEBRIS;
      for (const q of this.plats) {
        const b = this.pw.createBody({ position: V(q.x + q.w / 2, q.y + q.h / 2) });
        const cxB = q.x + q.w / 2;
        if (q.ice) {
          // glace fragmentée : une tuile = une fixture indépendante (on peut
          // en détruire une seule et laisser le reste du bloc debout). Les
          // tuiles ont des LARGEURS ALÉATOIRES => la casse est irrégulière
          q.tiles = [];
          let left = q.x;
          while (left < q.x + q.w - 1) {
            let tw = rand(C.ICE_TILE * 0.65, C.ICE_TILE * 1.35);
            const rest = q.x + q.w - left;
            // la dernière tuile absorbe le reste (pas de mini-tuile résiduelle)
            if (rest - tw < C.ICE_TILE * 0.6) tw = rest;
            tw = Math.min(tw, rest);
            const cx = left + tw / 2;
            const fx = b.createFixture({
              shape: new pl.Box(tw / 2 / S, q.h / 2 / S, V(cx - cxB, 0)),
              friction: 0.01,   // glissant
              filterCategoryBits: CAT.WORLD, filterMaskBits: mask,
            });
            fx.setUserData({ world: true });
            q.tiles.push({ x: left, cx, tw, alive: true, fx });
            left += tw;
          }
        } else {
          const fx = b.createFixture({
            shape: new pl.Box(q.w / 2 / S, q.h / 2 / S),
            friction: 0.6,
            filterCategoryBits: CAT.WORLD, filterMaskBits: mask,
          });
          fx.setUserData(q.solid ? { world: true } : { world: true, oneway: true, top: q.y });
        }
        q.body = b;
        this.platBodies.push(b);
      }

      // balançoires : planches cinématiques qui oscillent, praticables
      for (const d of swingDefs) {
        const sw = {
          ax: d.ax, ay: d.ay, L: d.L, amp: d.amp,
          om: Math.sqrt(C.GRAVITY / d.L) * 0.7, ph: d.ph || 0, w: d.w || 150,
        };
        sw.body = this.pw.createBody({ type: 'kinematic', position: V(sw.ax, sw.ay + sw.L) });
        sw.body.createFixture({
          shape: new pl.Box(sw.w / 2 / S, 7 / S), friction: 0.9,
          filterCategoryBits: CAT.WORLD,
          filterMaskBits: CAT.BODY | CAT.LIMB | CAT.DEBRIS,
        }).setUserData({ world: true });
        this.mapBodies.push(sw.body);
        this.swings.push(sw);
      }
      // caisses poussables
      for (const d of crateDefs) {
        const s = C.CRATE_S;
        const body = this.pw.createBody({ type: 'dynamic', position: V(d.x, d.y) });
        body.createFixture({
          shape: new pl.Box(s / 2 / S, s / 2 / S), density: 0.4, friction: 0.5,
          filterCategoryBits: CAT.WORLD | CAT.BODY,
          filterMaskBits: CAT.WORLD | CAT.BODY | CAT.LIMB | CAT.DEBRIS,
        }).setUserData({ world: true });
        this.mapBodies.push(body);
        this.crates.push({ body, s });
      }

      // armes fixées à la main sur la carte (éditeur) : posées au sol dès le
      // début de la manche, ramassables comme n'importe quelle arme libre
      for (const fw of fixedW) {
        if (fw.type && C.WEAPONS[fw.type]) {
          this._spawnWeapon(fw.x, fw.y, 0, 0, 0, null, fw.type);
        }
      }

      // points d'apparition : ceux de l'éditeur (avec arme éventuelle), sinon
      // répartis sur les plateformes stables (jamais sur des pics)
      if (defSpawns && defSpawns.length) {
        this.spawns = defSpawns.map((s) => ({ x: s.x, y: s.y, weapon: s.weapon }));
      } else {
        this.spawns = [];
        for (const q of this.plats) {
          if (q.mode) continue;
          const free = (x) => !this.hazards.some((h) =>
            x > h.x - 30 && x < h.x + h.w + 30 && Math.abs(q.y - h.y - 14) < 2);
          for (const fx of q.w > 300 ? [0.2, 0.5, 0.8] : [0.5]) {
            const x = q.x + q.w * fx;
            if (free(x)) this.spawns.push({ x, y: q.y });
          }
        }
        if (!this.spawns.length && this.plats.length) {
          const q = this.plats[0];
          this.spawns.push({ x: q.x + q.w / 2, y: q.y });
        }
        if (!this.spawns.length) this.spawns.push({ x: W / 2, y: H - 130 });
      }
    }

    // charge une map de l'éditeur : { theme, drops, plats:[{x,y,w,h,mode,ice}],
    // spikes:[{x,y,w}], lava:{y,rise}, balls:[{ax,ay,L,amp}], lasers:[{x1..y2}],
    // swings:[{ax,ay,L,amp,w}], crates:[{x,y}], weapons:[{x,y,type}],
    // spawns:[{x,y,weapon}] }
    _loadDef(d) {
      const { H } = C.WORLD;
      this.theme = Math.min(C.THEMES.length - 1, Math.max(0, d.theme | 0));
      for (const q of d.plats || []) {
        this.plats.push({
          x: q.x, y: q.y, w: q.w, h: q.h, solid: true,
          mode: q.mode || null, ph: rand(0, 4000), timer: 0,
          ice: !!q.ice,
        });
      }
      for (const s of d.spikes || []) {
        this.hazards.push({ x: s.x, y: s.y, w: s.w, h: 14 });
      }
      if (d.lava) {
        this.lava = { y: d.lava.y, rise: d.lava.rise ? C.LAVA_RISE : 0, max: H - 520 };
      }
      for (const b of d.balls || []) {
        this.balls.push({
          ax: b.ax, ay: b.ay, L: b.L, amp: b.amp || 0.8,
          om: Math.sqrt(C.GRAVITY / b.L) * 0.8, ph: rand(0, 6.28),
          r: 30, x: b.ax, y: b.ay + b.L,
        });
      }
      for (const l of d.lasers || []) {
        this.lasers.push({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
          ph: rand(0, 2000), on: false });
      }
      return {
        swings: (d.swings || []).map((s) => ({ ax: s.ax, ay: s.ay, L: s.L,
          amp: s.amp || 0.45, w: s.w || 150, ph: rand(0, 6.28) })),
        crates: d.crates || [],
        spawns: d.spawns || null,
        weapons: d.weapons || [],
      };
    }

    // génération aléatoire (comportement historique)
    _randomMap() {
      const { W, H } = C.WORLD;
      // sol : 2-3 gros blocs séparés par des trous mortels
      const gy = H - 130;
      let x = rand(30, 110);
      while (x < W - 260) {
        const w = Math.min(rand(340, 680), W - 30 - x);
        if (w < 200) break;
        this.plats.push({ x, y: gy, w, h: 52, solid: true });
        x += w + rand(110, 180);
      }
      // plateformes flottantes pleines (comme le sol) : on ne passe pas à
      // travers, il faut s'accrocher au flanc et sauter pour remonter
      const rows = [gy - 170, gy - 330, gy - 490];
      for (const ry of rows) {
        const n = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < n; i++) {
          const w = rand(190, 380);
          const px = rand(60, W - 60 - w);
          const py = ry + rand(-30, 30);
          if (this.plats.some((q) => Math.abs(q.y - py) < 110 &&
              px < q.x + q.w + 60 && px + w > q.x - 60)) continue;
          // blocs épais : assez de flanc pour s'y coller et sauter au mur
          this.plats.push({ x: px, y: py, w, h: rand(55, 90), solid: true });
        }
      }
      // blocs spéciaux (flottants seulement, jamais le sol) : clignotants,
      // friables (s'effondrent après un passage) ou en glace (glissante,
      // cassable par les balles et les explosions)
      for (const q of this.plats) {
        if (q.y >= gy) continue;
        const r = Math.random();
        if (r < 0.16) { q.mode = 'blink'; q.ph = rand(0, 4000); }
        else if (r < 0.30) { q.mode = 'crumble'; q.timer = 0; }
        else if (r < 0.30 + C.ICE_CHANCE) { q.ice = true; }
      }
      // thème visuel + dangers : pics sur certains blocs, lave en contrebas
      // (parfois montante — grimpez !)
      this.theme = Math.floor(Math.random() * C.THEMES.length);
      for (const q of this.plats) {
        if (q.w < 170 || q.mode || q.ice || Math.random() > C.SPIKE_CHANCE) continue;
        // les pics couvrent une partie du dessus du bloc
        const sw = Math.min(q.w - 40, rand(90, 220));
        const sx = q.x + rand(20, q.w - 20 - sw);
        this.hazards.push({ x: sx, y: q.y - 14, w: sw, h: 14 });
      }
      if (Math.random() < C.LAVA_CHANCE) {
        this.lava = {
          y: H - 20,
          rise: Math.random() < 0.5 ? C.LAVA_RISE : 0,
          max: H - 520,           // la montée s'arrête aux étages supérieurs
        };
      }
      // boules piquantes : pendules accrochés au plafond
      if (Math.random() < 0.35) {
        const n = 1 + (Math.random() < 0.3 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const L = rand(200, 340);
          this.balls.push({
            ax: rand(W * 0.2, W * 0.8), ay: rand(30, 130), L,
            amp: rand(0.55, 1.05), om: Math.sqrt(C.GRAVITY / L) * 0.8,
            ph: rand(0, 6.28), r: 30, x: 0, y: 0,
          });
        }
      }
      // laser : rayon clignotant vertical ou horizontal
      if (Math.random() < 0.3) {
        if (Math.random() < 0.5) {
          const lx = rand(W * 0.2, W * 0.8);
          this.lasers.push({ x1: lx, y1: -40, x2: lx, y2: H, ph: rand(0, 2000), on: false });
        } else {
          const ly = rand(H - 460, H - 220);
          this.lasers.push({ x1: -40, y1: ly, x2: W + 40, y2: ly, ph: rand(0, 2000), on: false });
        }
      }
      const out = { swings: [], crates: [] };
      if (Math.random() < 0.3) {
        out.swings.push({
          ax: rand(W * 0.25, W * 0.75), ay: rand(30, 110),
          L: rand(230, 360), amp: rand(0.35, 0.6), w: 150, ph: rand(0, 6.28),
        });
      }
      const grounds = this.plats.filter((q) => q.y === gy && q.w > 250);
      const nc = Math.floor(rand(0, 3));
      for (let i = 0; i < nc && grounds.length; i++) {
        const q = grounds[Math.floor(Math.random() * grounds.length)];
        out.crates.push({
          x: rand(q.x + 40, q.x + q.w - 40),
          y: q.y - C.CRATE_S / 2 - 2,
        });
      }
      return out;
    }

    startRound() {
      this.round.n++;
      this.round.phase = 'play';
      this.round.timer = 0;
      this.round.winner = '';
      for (const w of this.weapons.values()) this.pw.destroyBody(w.body);
      this.weapons.clear();
      this.bullets.length = 0;
      this.booms.length = 0;
      this.dropT = C.DROP_MS;
      this.newMap();
      // répartit les joueurs sur des spawns distincts (les cadavres de la
      // manche précédente disparaissent : les pantins sont reconstruits)
      const pool = this.spawns.slice().sort(() => Math.random() - 0.5);
      let i = 0;
      for (const p of this.players.values()) {
        const s = pool[i++ % pool.length];
        this.spawn(p, s);   // le spawn choisi impose aussi l'arme de départ
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
      this._tickBullets(dtMs);
      this._tickDrops(dtMs);
      this._tickHazards(dtMs);
      this._tickMapObjects(dtMs);
      this._tickIceChunks(dtMs);
      for (let i = this.booms.length - 1; i >= 0; i--) {
        if ((this.booms[i].t -= dtMs) <= 0) this.booms.splice(i, 1);
      }
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
      // l'affalement (p.limp) ne se résorbe pas tout seul : il faut se débattre
      // (géré plus bas selon les entrées)

      // charge du Kaméaméa : on cumule la rotation de la visée tant qu'elle
      // tourne dans le même sens ; un tour complet à mains nues charge le
      // poing, une pause ou un demi-tour inverse remet le compteur à zéro
      const da = norm(p.aim - p._pa);
      p._pa = p.aim;
      if (Math.abs(da) > 0.03) {
        p.spinIdle = 0;
        if (p.spin !== 0 && Math.sign(da) !== Math.sign(p.spin)) p.spin = 0;
        p.spin += da;
        if (Math.abs(p.spin) >= C.KAME_SPIN) {
          p.spin = 0;
          if (!p.weapon) p.kame = C.KAME_MS;
        }
      } else {
        p.spinIdle += dtMs;
        if (p.spinIdle > C.KAME_IDLE_MS) p.spin = 0;
      }
      p.kame = Math.max(0, p.kame - dtMs);
      p.onGround = this._grounded(p, vyPx);

      // bouclier levé (clic droit) : il s'use tant qu'il est tenu ; sinon
      // il se régénère après un répit sans dégât
      p.blocking = !!inp.block && p.sh > 0;
      p.shT += dtMs;
      if (p.blocking) {
        p.sh = Math.max(0, p.sh - C.SHIELD_DRAIN * dt);
        p.shT = 0;
      } else if (p.shT > C.SHIELD_DELAY_MS && p.sh < C.SHIELD) {
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
      // sur la glace : presque pas d'accroche, on glisse comme une savonnette
      const onIce = p.onGround && this.plats.some((q) => q.ice && !q.off &&
        p.x > q.x - 6 && p.x < q.x + q.w + 6 && Math.abs(p.y - q.y) < 12);
      // couché : écrasé sous un bloc (limp, involontaire) ou volontairement
      // allongé (touche bas, au sol). Dans les deux cas on rampe faiblement.
      const limp = p.limp > 0;
      // se débattre pour sortir de sous le bloc : gigoter gauche/droite ou
      // marteler le saut résorbe vite l'affalement ; sinon il traîne longtemps
      if (limp) {
        const struggling = dir !== 0 || inp.jump;
        inp.jump = false;   // le saut sert à se débattre, pas à sauter
        p.limp = Math.max(0, p.limp - dtMs * (struggling ? 2.6 : 0.25));
      }
      const prone = !limp && !!inp.down && p.onGround && p.stagger <= 0;
      const lie = limp || prone;
      const ctrl = limp ? 0.4 : (prone ? 0.5 : 1);
      const acc = (p.onGround ? C.ACCEL : C.AIR_ACCEL) * dt *
        (onIce ? C.ICE_ACCEL_MUL : 1) * ctrl;
      const tgt = target * ctrl;
      if (p.stagger <= 0) {
        if (dir !== 0) {
          if (vx < tgt) vx = Math.min(tgt, vx + acc);
          else vx = Math.max(tgt, vx - acc);
        } else if (p.onGround && !lie) {
          const f = C.FRICTION * dt * (onIce ? C.ICE_FRICTION_MUL : 1);
          vx = Math.abs(vx) <= f ? 0 : vx - Math.sign(vx) * f;
        }
      }
      // glissade lente le long de la paroi
      if (onWall && vy > C.WALL_SLIDE_VY) vy = C.WALL_SLIDE_VY;

      // saut (double saut autorisé) + tolérance "coyote" + saut mural
      p.coyote = p.onGround ? C.COYOTE_MS : Math.max(0, p.coyote - dtMs);
      if (p.onGround && vyPx >= 0) p.jumps = 0;
      if (inp.jump && !limp) {   // aplati au sol : impossible de sauter
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
      const run = Math.min(1, Math.abs(vxPx) / C.MOVE);
      // cible d'équilibre : à plat au sol quand on est couché ou écrasé
      // (torse ≈ horizontal), sinon vertical penché dans le sens de la course
      const lean = lie ? p.facing * 1.45 : clamp(vxPx / C.MOVE, -1, 1) * T.LEAN;
      // écrasé/couché : on plaque franchement le torse à l'horizontale (il
      // s'affale au sol sous le bloc) ; sinon équilibre debout normal
      const k = lie ? 24 : (p.stagger > 0 ? 2 : (p.onGround ? T.K_SOL : T.K_AIR));
      const d = lie ? (limp ? 0.9 : 1.1) : (p.stagger > 0 ? 0.3 : T.AMORTI);
      torso.applyTorque(-(torso.getAngle() - lean) * k - torso.getAngularVelocity() * d);

      // couples max ré-appliqués chaque tick ; réduits quasi à néant quand on
      // est couché/écrasé pour que les membres pendent mollement au sol
      const jm = lie ? 0.15 : 1;
      r.hips[0].setMaxMotorTorque(T.T_JAMBES * jm);
      r.hips[1].setMaxMotorTorque(T.T_JAMBES * jm);
      r.shoulders[0].setMaxMotorTorque(T.T_BRAS * jm);
      r.shoulders[1].setMaxMotorTorque(T.T_BRAS2 * jm);
      r.neck.setMaxMotorTorque(T.T_COU * jm);

      // démarche : les hanches suivent une sinusoïde ; jambes repliées en l'air.
      // la phase avance TOUJOURS (même à l'arrêt) pour animer le dodelinement
      p.phase += (3.5 + Math.abs(vxPx) * 0.05) * dt;
      const swing = Math.sin(p.phase) * T.FOULEE * run;
      // jambes franchement écartées au repos : plus un « I », plutôt un pantin
      // avachi sur ses deux appuis ; l'écart se résorbe quand on court. Un léger
      // ballant asymétrique donne l'allure molle
      const stance = 0.5 * (1 - run);
      const bob = Math.sin(p.phase * 0.5) * 0.12 * (1 - run);
      this._servo(r.hips[0], p.onGround ? swing + stance + bob : 0.55, T.G_JAMBES);
      this._servo(r.hips[1], p.onGround ? -swing - stance + bob : -0.3, T.G_JAMBES);
      // la tête dodeline nettement (repère la mollesse, façon Stick Fight)
      this._servo(r.neck, Math.sin(p.phase * 0.5) * 0.18, T.G_COU);

      // lancer de l'arme tenue : elle part en tournoyant vers la visée
      if (inp.throw) {
        inp.throw = false;
        if (p.weapon && p.atkT < 0) {
          const type = p.weapon, ammo = p.ammo;
          p.weapon = null;
          const dx = Math.cos(p.aim), dy = Math.sin(p.aim);
          this._spawnWeapon(
            p.x + dx * 30, p.y - 34 + dy * 30,
            dx * C.THROW_SPEED + vxPx * 0.5, dy * C.THROW_SPEED,
            34 * p.facing, p.id, type, ammo);   // rotation d'hélice
        }
      }

      const W = p.weapon ? C.WEAPONS[p.weapon] : null;
      p.cd = Math.max(0, p.cd - dtMs);
      p.mu = Math.max(0, p.mu - dtMs);

      if (W && !W.melee) {
        // arme à feu : tir à la cadence tant que le bouton est tenu
        if ((inp.attack || inp.attackHeld) && p.cd <= 0 && p.ammo > 0) {
          this._fire(p, W);
        }
        inp.attack = false;
        p.atkT = -1;
      } else if (inp.attack) {
        // mêlée (arme blanche, ou poings / pieds en alternance à mains nues)
        inp.attack = false;
        if (p.cd <= 0 && p.atkT < 0) {
          p.atkT = 0;
          p.cd = C.ATK_COOLDOWN_MS;
          p.hitIds.clear();
          p.combo++;
        }
      }
      const kicking = !p.weapon && p.atkT >= 0 && p.combo % 2 === 0;
      // bras d'attaque asservi vers la souris ; une arme à feu reste en joue,
      // la mêlée balaie un grand arc autour de la visée (plus court au poing)
      let rel = (W && !W.melee) ? 0 : (p.weapon ? -0.35 : -0.15) * p.facing;
      if (p.atkT >= 0 && !kicking) {
        const q = Math.min(1, p.atkT / C.ATK_TOTAL_MS);
        const e = 1 - (1 - q) * (1 - q);
        rel = (p.weapon ? (-1.7 + e * 3.0) : (-0.9 + e * 1.4)) * p.facing;
      }
      // consigne du joint : angle monde voulu, moins l'angle du torse, moins
      // la référence π/2 (le bras est créé pendant vers le bas)
      this._servo(r.shoulders[0], p.aim + rel - torso.getAngle() - Math.PI / 2, T.G_BRAS);
      // bras arrière : balance en course, pendouille et ballotte au repos
      this._servo(r.shoulders[1],
        -Math.sin(p.phase) * 0.8 * run + (0.25 + Math.sin(p.phase * 0.5) * 0.3) * (1 - run), 8);
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
      // portée et dégâts selon l'arme blanche (poings / pieds sans arme)
      const W = p.weapon ? C.WEAPONS[p.weapon] : null;
      const range = W ? W.range : C.ATK_RANGE * C.FIST_RANGE_MUL;
      const baseDmg = W ? W.dmg : C.FIST_DMG;
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
        // poing Kaméaméa : dégâts boostés, la victime décolle à la verticale
        const kame = !p.weapon && p.kame > 0;
        if (kame) {
          p.kame = 0;
          dmg = Math.round(dmg * C.KAME_DMG_MUL);
        }
        this._damage(e, dmg);
        e.ht = C.HIT_FLASH_MS * (crit ? 1.8 : 1);
        e.htCrit = crit;
        e.stagger = 320;
        if (kame) {
          e.stagger = 650;
          const tb2 = e.ragdoll.torso;
          tb2.setLinearVelocity(new pl.Vec2(0, -C.KAME_UP / S));
          tb2.setAngularVelocity(p.facing * 9);
          if (e.hp <= 0) { e.hp = 0; this._die(e); }
          continue;
        }
        // projection dans la direction du coup, amplifiée par les dégâts
        // subis (façon Smash), avec une rotation pour l'effet chiffon
        const scale = (0.7 + ((C.HP - Math.max(0, e.hp)) / C.HP) * 1.4) *
          (e.blocking ? 0.35 : 1);   // bien campé derrière son bouclier
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
        return [Math.round(q.x * S), Math.round(q.y * S), r2(w.body.getAngle()), w.type];
      });
    }

    viewBullets() {
      return this.bullets.map((b) => [Math.round(b.x), Math.round(b.y),
        Math.round(b.x - b.vx * 0.015), Math.round(b.y - b.vy * 0.015),
        b.expl ? 1 : 0]);
    }

    // explosions : position, rayon, progression de l'effet (1 -> 0)
    viewBooms() {
      return this.booms.map((b) => [Math.round(b.x), Math.round(b.y),
        b.r, r2(b.t / C.EXPL_FX_MS)]);
    }

    viewIceChunks() {
      return this.iceChunks.map((c) => {
        const q = c.body.getPosition();
        const flat = [];
        for (const v of c.verts) { flat.push(v[0], v[1]); }
        return [Math.round(q.x * S), Math.round(q.y * S),
          r2(c.body.getAngle()), flat];
      });
    }

    // plateformes : [x,y,w,h, solid, présente, tremble, glace,
    //                nbTuiles, masqueTuilesVivantes] — les deux derniers
    //                champs pilotent le rendu fragmenté de la glace
    viewPlats() {
      return this.plats.map((q) => {
        // masque des tuiles vivantes en chaîne '0'/'1' (robuste même pour les
        // plateformes très larges) + largeurs des tuiles (elles sont variables)
        let tc = 0, alive = '', widths = 0;
        if (q.ice && q.tiles) {
          tc = q.tiles.length;
          alive = q.tiles.map((t) => (t.alive ? '1' : '0')).join('');
          widths = q.tiles.map((t) => Math.round(t.tw));
        }
        return [q.x | 0, q.y | 0, q.w | 0, q.h, q.solid ? 1 : 0,
          q.off ? 0 : 1, q.timer > 0 && !q.off ? 1 : 0,
          q.ice ? 1 : 0, tc, alive, widths];
      });
    }

    snapshot() {
      return {
        t: 'state',
        players: [...this.players.values()].map((p) => ({
          id: p.id, n: p.name, c: p.color, f: p.facing,
          hp: p.hp, sh: Math.round(p.sh), bl: p.blocking ? 1 : 0,
          d: p.dead ? 1 : 0, s: p.score,
          w: p.weapon || 0, mn: p.ammo, mu: p.mu > 0 ? 1 : 0,
          k: p.kame > 0 ? 1 : 0,
          ht: p.ht > 0 ? (p.htCrit ? 2 : 1) : 0,
          b: this.viewPlayer(p),
        })),
        wp: this.viewWeapons(),
        bu: this.viewBullets(),
        bx: this.viewBooms(),
        th: this.theme,
        hz: this.hazards.map((h) => [h.x | 0, h.y | 0, h.w | 0, h.h | 0]),
        lv: this.lava ? Math.round(this.lava.y) : -1,
        sb: this.balls.map((b) => [b.ax | 0, b.ay | 0,
          Math.round(b.x), Math.round(b.y), b.r]),
        ls: this.lasers.map((l) => [l.x1 | 0, l.y1 | 0, l.x2 | 0, l.y2 | 0,
          l.on ? 1 : 0]),
        sw: this.swings.map((s) => {
          const q = s.body.getPosition();
          return [s.ax | 0, s.ay | 0, Math.round(q.x * S), Math.round(q.y * S),
            r2(s.body.getAngle()), s.w];
        }),
        cr: this.crates.map((c) => {
          const q = c.body.getPosition();
          return [Math.round(q.x * S), Math.round(q.y * S),
            r2(c.body.getAngle()), c.s];
        }),
        ik: this.viewIceChunks(),
        plats: this.viewPlats(),
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
