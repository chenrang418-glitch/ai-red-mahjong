// PM2 配置。部署流程：git pull → npm ci → npm run build → pm2 reload
module.exports = {
  apps: [{
    name: 'ai-red-mahjong',
    script: 'dist/server-node/src/index.js',
    // cwd 固定在 server-node，数据库和迁移目录都按仓库结构自动定位
    cwd: __dirname,
    instances: 1,
    // 房间状态在进程内存里，多实例会各自持有一份，必须单进程
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
      PORT: 8787,
      HOST: '127.0.0.1',
    },
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    time: true,
  }],
}
