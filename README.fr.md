# Clash of the Sticks

🇬🇧 [English version](README.md)

Baston de bonshommes bâtons en 2D, **4 joueurs max, entre copains**, jouable
dans le navigateur **sans aucun serveur de jeu** : tout tourne en pair-à-pair
via WebRTC, sur le même principe que [Blobule](https://github.com/flamme-demon/blobule).

## Comment ça marche

- **L'hôte est le serveur.** Le joueur qui crée la partie fait tourner toute
  la simulation dans son navigateur.
- **Invitation par lien.** L'hôte partage un lien (ou un code) ; la baston
  démarre dès que le deuxième joueur arrive. Pas de bots.
- Le serveur public [PeerJS](https://peerjs.com) ne sert qu'à la mise en
  relation initiale (signaling) — aucune donnée de jeu n'y transite.

## Règles

Arène générée aléatoirement à chaque manche. Dernier debout gagne la manche
(+1 au tableau des scores). On meurt en tombant dans les trous ou à 0 PV —
et plus on est amoché, plus les coups de bâton nous projettent loin.
La souris vise : le bâton frappe dans sa direction, et un coup ajusté sur
la tête fait des dégâts critiques. Lancez votre bâton comme une hélice,
battez-vous aux poings et aux pieds une fois désarmé, et marchez sur un
bâton au sol pour le ramasser. Les morts lâchent leur arme.
Maintenez le clic droit pour lever un bouclier : sa jauge encaisse les
dégâts (et s'use tant qu'il est levé) puis se régénère après un répit.
Les plateformes sont pleines : collez-vous à leur flanc et sautez pour
remonter (saut mural).

## Physique

Les personnages sont de vrais ragdolls articulés simulés par
[Planck.js](https://piqnt.com/planck.js) (portage JavaScript de Box2D,
embarqué dans `js/vendor/`, aucun CDN) : capsule de torse tenue debout par
un ressort angulaire, tête, bras et jambes pendus par des joints motorisés.
Un coup reçu coupe brièvement l'équilibre (on chancelle), et à la mort tous
les moteurs lâchent : le corps s'effondre et le cadavre reste dans l'arène
jusqu'à la fin de la manche.

## Jouer en local

```bash
python3 -m http.server 8080
# puis http://localhost:8080
```

Pour inviter des copains sans hébergement ni ouverture de port, un tunnel
suffit (la partie elle-même passe en WebRTC direct, navigateur à navigateur) :

```bash
cloudflared tunnel --url http://localhost:8080
```

## Contrôles

| Entrée                  | Action                       |
|-------------------------|------------------------------|
| ← → ou Q D              | Se déplacer                  |
| ↑, Z ou Espace          | Sauter (double saut)         |
| Souris                  | Viser (la tête = critique !) |
| E ou clic               | Frapper                      |
| F                       | Lancer le bâton              |
| Clic droit (maintenu)   | Lever le bouclier            |
