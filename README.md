# Clash of the Sticks

🇫🇷 [Version française](README.fr.md)

A 2D stick-figure brawler for **up to 4 friends**, playable in the browser
with **no game server at all**: everything runs peer-to-peer over WebRTC,
following the same recipe as [Blobule](https://github.com/flamme-demon/blobule).

## How it works

- **The host is the server.** The player who creates the game runs the whole
  simulation in their browser.
- **Invite by link.** The host shares a link (or a code); the brawl starts as
  soon as the second player joins. No bots.
- The public [PeerJS](https://peerjs.com) server is only used for the initial
  WebRTC handshake (signaling) — no game data ever goes through it.

## Rules

A random arena is generated every round. Last one standing wins the round
(+1 on the scoreboard). You die by falling into the gaps or at 0 HP — and
the more beat-up you are, the further hits send you flying.
The mouse aims: your stick strikes in its direction, and a well-aimed blow
to the head deals critical damage. Throw your stick like a spinning
propeller, fight with fists and feet when unarmed, and walk over a stick
on the ground to pick it up. The dead drop their weapon.
Hold right click to raise a shield: its gauge absorbs damage (and wears
down while raised) and regenerates after a short respite. Platforms are
solid — cling to their sides and wall-jump to climb up. Also, and you can cling to walls and jump off them to
climb back up.

## Physics

Characters are real articulated ragdolls simulated by
[Planck.js](https://piqnt.com/planck.js) (a JavaScript port of Box2D,
bundled in `js/vendor/`, no CDN): a torso capsule held upright by an
angular spring, plus a head, arms and legs hanging from motorized joints.
Getting hit briefly cuts your balance (you stagger), and on death every
motor lets go: the body crumples and the corpse stays in the arena until
the next round.

## Play locally

```bash
python3 -m http.server 8080
# then http://localhost:8080
```

To invite friends without any hosting or port forwarding, a tunnel is
enough (the game itself runs over direct browser-to-browser WebRTC):

```bash
cloudflared tunnel --url http://localhost:8080
```

## Controls

| Input                   | Action                        |
|-------------------------|-------------------------------|
| ← → or Q D              | Move                          |
| ↑, Z or Space           | Jump (double jump)            |
| Mouse                   | Aim (the head = critical!)    |
| E or click              | Strike                        |
| F                       | Throw your stick              |
| Right click (hold)      | Raise your shield             |
