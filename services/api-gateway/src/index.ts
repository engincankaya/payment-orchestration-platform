import container from './bootstrap/container';
import ServerApplication from './server/server';

const port = Number(process.env.PORT ?? 8080);
const server = container.resolve<ServerApplication>('server');

server.app.listen(port, () => {
  console.log(`api-gateway listening on port ${port}`);
});
