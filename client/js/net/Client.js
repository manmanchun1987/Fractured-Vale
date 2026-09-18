/* global Colyseus */
window.FVNet = (function () {
  function endpoint() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // Same host as page (Replit / local / reverse-proxy)
    return `${proto}//${location.host}`;
  }

  async function connectWorld(options) {
    const client = new Colyseus.Client(endpoint());
    const room = await client.joinOrCreate("world", options);
    return { client, room };
  }

  return { endpoint, connectWorld };
})();
