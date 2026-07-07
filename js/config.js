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
      // armes blanches : lancées, elles filent droit (javelot) et font mal
      baton:    { nom: 'Bâton', melee: 1, dmg: 16, range: 82, throwDmg: 32 },
      epee:     { nom: 'Épée', melee: 1, dmg: 24, range: 95, throwDmg: 42 },
      lance:    { nom: 'Lance', melee: 1, dmg: 18, range: 150, throwDmg: 50 },
      pistolet: { nom: 'Pistolet', dmg: 12, ammo: 10, rate: 280, speed: 1500, recul: 170 },
      uzi:      { nom: 'Uzi', dmg: 6, ammo: 30, rate: 90, speed: 1400, spread: 0.12, recul: 90 },
      pompe:    { nom: 'Pompe', dmg: 7, ammo: 6, rate: 700, speed: 1300, pellets: 5, spread: 0.22, recul: 1500 },
      sniper:   { nom: 'Sniper', dmg: 45, ammo: 3, rate: 1100, speed: 2600, recul: 850 },
      // fournée Stick Fight officielle
      revolver: { nom: 'Revolver', dmg: 22, ammo: 6, rate: 520, speed: 1900, recul: 380 },
      ak47:     { nom: 'AK-47', dmg: 9, ammo: 25, rate: 130, speed: 1600, spread: 0.06, recul: 120 },
      minigun:  { nom: 'Minigun', dmg: 5, ammo: 100, rate: 55, speed: 1500, spread: 0.16, recul: 300 },
      sabre:    { nom: 'Sabre laser', melee: 1, dmg: 32, range: 105, throwDmg: 60 },
      // explosifs : grav = gravité du projectile (px/s²), expl = rayon (px)
      grenades: { nom: 'Lance-grenades', dmg: 34, ammo: 4, rate: 800, speed: 950, grav: 1600, expl: 95, recul: 320 },
      rpg:      { nom: 'RPG', dmg: 55, ammo: 1, rate: 1200, speed: 1100, expl: 130, recul: 1100 },
    },
    DROPS: ['epee', 'lance', 'pistolet', 'uzi', 'pompe', 'sniper',
      'revolver', 'ak47', 'minigun', 'sabre', 'grenades', 'rpg'],
    EXPL_KNOCK: 700,              // projection au centre d'une explosion (px/s)
    EXPL_FX_MS: 320,              // durée de l'effet visuel d'explosion
    // Kaméaméa : 4 tours de souris autour du perso (à mains nues) chargent
    // le poing ; le prochain coup envoie la victime droit vers le ciel
    KAME_SPIN: Math.PI * 8,       // rotation cumulée à boucler pour charger (4 tours)
    KAME_IDLE_MS: 350,            // pause de souris qui casse la charge en cours
    KAME_MS: 4000,                // le poing chargé reste prêt pendant 4 s
    KAME_UP: 1750,                // envol vertical de la victime (px/s)
    KAME_DMG_MUL: 1.5,            // bonus de dégâts du poing chargé
    DROP_MS: 8000,                // une arme tombe du ciel toutes les ~8 s
    DROP_MAX: 3,                  // max d'armes libres posées en même temps
    DROP_FALL: 170,               // descente plafonnée des largages (px/s),
                                  // assez lent pour les attraper au vol
    BULLET_LIFE_MS: 1300,
    SHIELD: 40,                   // jauge de bouclier (absorbe avant les PV)
    SHIELD_REGEN: 6,              // régénération du bouclier (points/s)
    SHIELD_DRAIN: 10,             // usure du bouclier levé (points/s)
    SHIELD_DELAY_MS: 2500,        // délai sans dégât avant régénération
    WALL_SLIDE_VY: 130,           // glissade lente collé à une paroi (px/s)
    CRUSH_LIMP_MS: 950,           // durée d'affalement quand un bloc écrase
                                  // (corps mou au sol, on gigote pour sortir)
    KNOCK: 470,                   // projection, dans la direction de visée
                                  // (augmente avec les dégâts subis, façon Smash)
    HIT_FLASH_MS: 140,
    KILL_Y: 142,                  // marge sous l'arène (15 % de sa hauteur)
    KILL_X: 400,                  // marge latérale
    ROUND_END_MS: 2800,           // pause entre deux manches
    TICK_MS: 16,                  // simulation ~60 Hz
    NET_MS: 50,                   // envoi d'état / d'entrées ~20 Hz
    COLORS: ['#ff5c5c', '#4da3ff', '#ffd166', '#6ee7a0'],
    // thèmes visuels des cartes (fond haut/bas, blocs, liseré supérieur)
    THEMES: [
      { nom: 'Nuit', bg: ['#171b26', '#0e1017'], plat: '#2c3446', top: '#48546e' },
      { nom: 'Désert', bg: ['#4a3821', '#221709'], plat: '#6b5432', top: '#96793e' },
      { nom: 'Hiver', bg: ['#22304a', '#0d1420'], plat: '#3d5a73', top: '#b8d4e8' },
      { nom: 'Volcan', bg: ['#301414', '#140808'], plat: '#3a2626', top: '#6b3a2a' },
    ],
    // dangers des cartes : pics et lave (parfois montante)
    HAZARD_CD_MS: 650,            // délai anti-double-déclenchement des pièges
    LAVA_DPS: 45,                 // brûlure de la lave (PV/s)
    LAVA_KNOCK: 900,              // la lave recrache vers le haut (px/s)
    LAVA_RISE: 16,                // vitesse de montée de la lave (px/s)
    LAVA_CHANCE: 0.4,             // probabilité d'une carte avec lave
    SPIKE_CHANCE: 0.25,           // probabilité de pics par bloc
                                  // (les pics tuent instantanément au contact)
    // objets dynamiques des cartes
    BALL_KNOCK: 820,             // projection de la boule piquante (tue net)
    LASER_DMG: 30,                // rayon laser (clignote : on/off)
    LASER_ON_MS: 1400,
    LASER_OFF_MS: 900,
    CRATE_S: 46,                  // côté des caisses poussables (px)
    BLINK_ON_MS: 1700,            // sols clignotants : visible / disparu
    BLINK_OFF_MS: 900,
    CRUMBLE_MS: 700,              // sols friables : délai avant l'effondrement
    ICE_CHANCE: 0.25,             // probabilité de blocs de glace par carte
    ICE_ACCEL_MUL: 0.12,          // accélération très réduite sur la glace
    ICE_FRICTION_MUL: 0.025,      // quasi aucune friction : patinoire !
    // glace fragmentée : la plateforme est découpée en tuiles ; chaque tir
    // détache la tuile touchée, qui tombe (le reste tient encore)
    ICE_TILE: 64,                 // largeur d'une tuile de glace (px) : gros
                                  // éclats anguleux façon jeu d'origine
    ICE_CHUNK_MAX: 55,            // nombre max de morceaux qui tombent
    ICE_FALL_MIN_VY: 240,         // vitesse de chute mini pour blesser (px/s)
    ICE_FALL_DMG_MAX: 26,         // dégâts max d'un morceau qui tombe de haut
    // réglages du "feel" physique — modifiables en direct avec la touche T
    TUNE: {
      LEAN: 0.45,      // inclinaison du torse en course (rad)
      K_SOL: 40,       // raideur du ressort d'équilibre au sol (stable, il marche)
      K_AIR: 4,        // ... en l'air (faible = vrilles)
      AMORTI: 1.2,     // amortissement de l'équilibre
      FOULEE: 1.8,     // amplitude de la démarche (rad)
      G_JAMBES: 13,    // vivacité des jambes
      G_BRAS: 20,      // vivacité du bras du bâton
      G_COU: 7,        // tenue de la tête (basse = la tête dodeline)
      // membres purement décoratifs : couples faibles => ils pendent, ballottent
      // et flottent librement (aspect mou, sans faire basculer le torse)
      T_JAMBES: 5,     // force max des hanches
      T_BRAS: 8,       // force max de l'épaule (bâton)
      T_BRAS2: 1.5,    // force max du bras arrière (pend mollement)
      T_COU: 2.5,      // force max du cou
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CFG;
  else global.CFG = CFG;
})(typeof window !== 'undefined' ? window : globalThis);
