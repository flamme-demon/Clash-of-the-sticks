// Constantes du jeu — partagées entre la simulation, le rendu et le réseau.
(function (global) {
  const CFG = {
    MAX_PLAYERS: 4,               // jeu entre copains : 4 joueurs max, pas de bots
    WORLD: { W: 1700, H: 950 },   // taille de l'arène (unités monde)
    SCALE: 40,                    // pixels par mètre physique (Planck/Box2D)
    GRAVITY: 2300,                // px/s²
    MOVE: 330,                    // vitesse horizontale max
    ACCEL: 3400,                  // accélération au sol
    AIR_ACCEL: 2000,              // accélération en l'air
    FRICTION: 3000,               // décélération au sol sans entrée
    JUMP: 880,                    // impulsion du saut (px/s)
    DOUBLE_JUMP: 800,             // impulsion du second saut
    COYOTE_MS: 90,                // tolérance de saut après avoir quitté un bord
    PLAYER: { W: 26, H: 58 },     // boîte de collision (pieds en y)
    HP: 100,
    ATK_DMG: 16,
    ATK_HEAD_MULT: 1.6,           // bonus de dégâts en visant la tête
    ATK_RANGE: 82,                // portée du coup de bâton
    ATK_RADIUS: 34,               // rayon de la zone de frappe (au bout du bâton)
    HEAD_R: 13,                   // rayon de la tête (pour les coups critiques)
    ATK_TOTAL_MS: 280,            // durée de l'animation de frappe
    ATK_HIT_FROM: 60,             // fenêtre active du coup (ms depuis le début)
    ATK_HIT_TO: 190,
    ATK_COOLDOWN_MS: 480,
    FIST_DMG: 10,                 // dégâts à mains nues (poings / pieds)
    FIST_RANGE_MUL: 0.62,         // portée réduite sans arme
    THROW_SPEED: 950,             // vitesse du bâton lancé (px/s)
    THROW_DMG: 24,                // dégâts d'un bâton reçu en pleine course
    // arsenal — melee: portée/dégâts du coup ; armes à feu : cadence (ms),
    // munitions, vitesse des balles, dispersion (rad), recul (px/s)
    WEAPONS: {
      baton:    { nom: 'Bâton', melee: 1, dmg: 16, range: 82, throwDmg: 24 },
      epee:     { nom: 'Épée', melee: 1, dmg: 24, range: 95, throwDmg: 30 },
      lance:    { nom: 'Lance', melee: 1, dmg: 18, range: 150, throwDmg: 36 },
      pistolet: { nom: 'Pistolet', dmg: 12, ammo: 10, rate: 280, speed: 1500, recul: 60 },
      uzi:      { nom: 'Uzi', dmg: 6, ammo: 30, rate: 90, speed: 1400, spread: 0.12, recul: 40 },
      pompe:    { nom: 'Pompe', dmg: 7, ammo: 6, rate: 700, speed: 1300, pellets: 5, spread: 0.22, recul: 420 },
      sniper:   { nom: 'Sniper', dmg: 45, ammo: 3, rate: 1100, speed: 2600, recul: 220 },
      // fournée Stick Fight officielle
      revolver: { nom: 'Revolver', dmg: 22, ammo: 6, rate: 520, speed: 1900, recul: 150 },
      ak47:     { nom: 'AK-47', dmg: 9, ammo: 25, rate: 130, speed: 1600, spread: 0.06, recul: 55 },
      minigun:  { nom: 'Minigun', dmg: 5, ammo: 100, rate: 55, speed: 1500, spread: 0.16, recul: 110 },
      sabre:    { nom: 'Sabre laser', melee: 1, dmg: 32, range: 105, throwDmg: 42 },
      // explosifs : grav = gravité du projectile (px/s²), expl = rayon (px)
      grenades: { nom: 'Lance-grenades', dmg: 34, ammo: 4, rate: 800, speed: 950, grav: 1600, expl: 95, recul: 120 },
      rpg:      { nom: 'RPG', dmg: 55, ammo: 1, rate: 1200, speed: 1100, expl: 130, recul: 280 },
    },
    DROPS: ['epee', 'lance', 'pistolet', 'uzi', 'pompe', 'sniper',
      'revolver', 'ak47', 'minigun', 'sabre', 'grenades', 'rpg'],
    EXPL_KNOCK: 700,              // projection au centre d'une explosion (px/s)
    EXPL_FX_MS: 320,              // durée de l'effet visuel d'explosion
    DROP_MS: 8000,                // une arme tombe du ciel toutes les ~8 s
    DROP_MAX: 3,                  // max d'armes libres posées en même temps
    BULLET_LIFE_MS: 1300,
    SHIELD: 40,                   // jauge de bouclier (absorbe avant les PV)
    SHIELD_REGEN: 6,              // régénération du bouclier (points/s)
    SHIELD_DRAIN: 10,             // usure du bouclier levé (points/s)
    SHIELD_DELAY_MS: 2500,        // délai sans dégât avant régénération
    WALL_SLIDE_VY: 130,           // glissade lente collé à une paroi (px/s)
    KNOCK: 470,                   // projection, dans la direction de visée
                                  // (augmente avec les dégâts subis, façon Smash)
    HIT_FLASH_MS: 140,
    KILL_Y: 142,                  // marge sous l'arène (15 % de sa hauteur)
    KILL_X: 400,                  // marge latérale
    ROUND_END_MS: 2800,           // pause entre deux manches
    TICK_MS: 16,                  // simulation ~60 Hz
    NET_MS: 50,                   // envoi d'état / d'entrées ~20 Hz
    COLORS: ['#ff5c5c', '#4da3ff', '#ffd166', '#6ee7a0'],
    // réglages du "feel" physique — modifiables en direct avec la touche T
    TUNE: {
      LEAN: 0.45,      // inclinaison du torse en course (rad)
      K_SOL: 46,       // raideur du ressort d'équilibre au sol
      K_AIR: 5,        // ... en l'air (faible = vrilles)
      AMORTI: 1.4,     // amortissement de l'équilibre
      FOULEE: 1.8,     // amplitude de la démarche (rad)
      G_JAMBES: 18,    // vivacité des jambes
      G_BRAS: 22,      // vivacité du bras du bâton
      G_COU: 10,       // tenue de la tête
      T_JAMBES: 9,     // force max des hanches
      T_BRAS: 12,      // force max de l'épaule (bâton)
      T_BRAS2: 3,      // force max du bras arrière
      T_COU: 4,        // force max du cou
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CFG;
  else global.CFG = CFG;
})(typeof window !== 'undefined' ? window : globalThis);
