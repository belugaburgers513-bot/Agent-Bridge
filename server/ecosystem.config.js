// pm2:  pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'orbitbridge',
    script: 'server.js',
    cwd: __dirname,
    env: {
      PORT: 3456,
      WORKSPACE_ROOT: '/root',        // change if you run as another user
      // TRUST_PROXY_HEADERS: '1',     // only if ALL traffic arrives via the CF tunnel
      // ALLOW_PRIVATE_FETCH: '1',    // let fetch_web_url hit private/loopback IPs
      // COMMAND_DENYLIST: 'rm -rf /||mkfs',  // custom denylist, entries joined with ||
      // STRICT_WORKSPACE: '0',       // allow file tools outside WORKSPACE_ROOT
      // ALLOWED_ORIGINS: 'https://chat.z.ai'
    },
    max_restarts: 20,
    restart_delay: 2000,
    kill_timeout: 4000
  }]
};
