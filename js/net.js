// Réseau P2P via PeerJS (WebRTC). Aucun serveur de jeu : le navigateur de
// l'hôte exécute la simulation, les invités n'échangent que leurs entrées
// et reçoivent l'état. Le serveur public PeerJS ne sert qu'à la mise en
// relation initiale (signaling), aucune donnée de jeu n'y transite.
(function (global) {
  const C = global.CFG;

  function peerAvailable() { return typeof global.Peer !== 'undefined'; }

  // ---------- côté hôte ----------
  function createHost(world, callbacks) {
    // callbacks: { onReady(id), onError(err), onPlayersChanged() }
    const host = {
      peer: null,
      conns: new Map(),        // peerId -> DataConnection
      inviteId: null,
      _lastCast: 0,
      // Appelé par la boucle de jeu (pilotée par un Worker, donc jamais
      // suspendue en arrière-plan). Se limite tout seul à ~20 envois/s.
      broadcast() {
        const now = Date.now();
        if (now - host._lastCast < C.NET_MS) return;
        host._lastCast = now;
        // détection des invités silencieux : la fermeture WebRTC peut mettre
        // >10 s à être signalée, or les invités envoient leurs entrées
        // ~20 fois/s — 5 s de silence = parti
        for (const conn of [...host.conns.values()]) {
          if (now - conn._lastSeen > 5000) {
            try { conn.close(); } catch (_) { /* déjà fermée */ }
            dropGuest(conn.peer);
          }
        }
        if (host.conns.size === 0) return;
        const snap = world.snapshot();
        for (const conn of host.conns.values()) {
          if (conn.open) {
            try { conn.send(snap); } catch (_) { /* connexion en cours de fermeture */ }
          }
        }
      },
      destroy() {
        if (host.peer) host.peer.destroy();
      },
    };

    if (!peerAvailable()) {
      callbacks.onError(new Error('PeerJS indisponible (hors ligne ?) — impossible d\'inviter.'));
      return host;
    }

    const peer = new global.Peer();
    host.peer = peer;

    peer.on('open', (id) => {
      host.inviteId = id;
      callbacks.onReady(id);
    });
    peer.on('error', (err) => callbacks.onError(err));

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        host.conns.set(conn.peer, conn);
        conn._lastSeen = Date.now();
      });
      conn.on('data', (msg) => {
        conn._lastSeen = Date.now();
        handleMessage(conn, msg);
      });
      conn.on('close', () => dropGuest(conn.peer));
      conn.on('error', () => dropGuest(conn.peer));
    });

    function handleMessage(conn, msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'join') {
        if (world.players.size >= C.MAX_PLAYERS) {
          conn.send({ t: 'full' });
          return;
        }
        const name = String(msg.name || 'Invité').slice(0, 16);
        world.addPlayer(conn.peer, name);
        conn.send({ t: 'init', you: conn.peer, world: C.WORLD });
        callbacks.onPlayersChanged();
      } else if (msg.t === 'input') {
        world.setInput(conn.peer, msg);
      }
    }

    function dropGuest(peerId) {
      if (!host.conns.has(peerId)) return;
      host.conns.delete(peerId);
      if (world.players.has(peerId)) {
        world.removePlayer(peerId);
        callbacks.onPlayersChanged();
      }
    }

    return host;
  }

  // ---------- côté invité ----------
  function joinGame(hostId, name, callbacks) {
    // callbacks: { onInit(msg), onState(msg), onFull(), onClose(), onError(err) }
    const client = {
      peer: null, conn: null, closed: false,
      sendInput(input) {
        if (client.conn && client.conn.open) {
          input.t = 'input';
          client.conn.send(input);
        }
      },
      destroy() {
        client.closed = true;
        if (client.peer) client.peer.destroy();
      },
    };

    if (!peerAvailable()) {
      callbacks.onError(new Error('PeerJS indisponible — vérifiez votre connexion.'));
      return client;
    }

    const peer = new global.Peer();
    client.peer = peer;
    peer.on('error', (err) => callbacks.onError(err));
    peer.on('open', () => {
      const conn = peer.connect(hostId, { reliable: true });
      client.conn = conn;
      conn.on('open', () => conn.send({ t: 'join', name }));
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'init') callbacks.onInit(msg);
        else if (msg.t === 'state') callbacks.onState(msg);
        else if (msg.t === 'full') callbacks.onFull();
      });
      conn.on('close', () => { if (!client.closed) callbacks.onClose(); });
      conn.on('error', (err) => callbacks.onError(err));
    });

    return client;
  }

  global.Net = { createHost, joinGame, peerAvailable };
})(window);
