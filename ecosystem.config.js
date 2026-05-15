// pm2 ecosystem config for DREK. Same VPS as Neurocore + PI.
// All secrets should come from environment, not be committed here.
module.exports = {
  apps: [
    {
      name: 'drek',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 3,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: '3003',
        LOG_LEVEL: 'info',
      },
    },
  ],
};
