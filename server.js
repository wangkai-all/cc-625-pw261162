'use strict';

/**
 * 本地演示服务：node server.js
 * 端口读环境变量 PORT，缺省 8080；只绑定 127.0.0.1。
 */

const { createServer } = require('./lib/app');

const rawPort = process.env.PORT;
const port = rawPort === undefined || rawPort === '' ? 8080 : Number(rawPort);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT 必须是 1–65535 的整数，收到「${rawPort}」`);
  process.exit(1);
}

const server = createServer();

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，换一个 PORT 再试`);
    process.exit(1);
  }
  console.error('服务启动失败', error);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`样品归因演示已启动：http://127.0.0.1:${port}/`);
  console.log('按 Ctrl+C 停止。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n正在停止服务…');
    server.close(() => process.exit(0));
  });
}
